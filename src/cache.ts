import type { CachePolicy, Env } from "./types";

type CacheEnvelope<T> = {
  value: T;
  cachedAt: string;
  expiresAt: string;
};

const memoryCache = new Map<string, CacheEnvelope<unknown>>();
const MAX_MEMORY_CACHE_ENTRIES = 256;
const MAX_DELETE_BATCH_SIZE = 1000;
const DEFAULT_STALE_RETENTION_SECONDS = 14 * 24 * 60 * 60;

export async function getOrSetJson<T>(
  env: Env,
  key: string,
  policy: CachePolicy,
  loader: () => Promise<T>,
): Promise<{
  value: T;
  cache: {
    key: string;
    hit: boolean;
    cachedAt: string;
    expiresAt: string;
    stale?: boolean;
  };
}> {
  let stale: CacheEnvelope<T> | null = null;
  if (!policy.force) {
    const cached = await readJson<T>(env, key, { allowExpired: true }).catch(
      (error) => {
        console.warn(`Cache read failed for ${key}`, error);
        return null;
      },
    );
    if (cached) {
      if (Date.parse(cached.expiresAt) > Date.now()) {
        return {
          value: cached.value,
          cache: {
            key,
            hit: true,
            cachedAt: cached.cachedAt,
            expiresAt: cached.expiresAt,
          },
        };
      }
      stale = cached;
    }
  }

  let value: T;
  try {
    value = await loader();
  } catch (error) {
    if (stale) {
      console.warn(`Loader failed for ${key}; returning stale cache`, error);
      return {
        value: stale.value,
        cache: {
          key,
          hit: true,
          stale: true,
          cachedAt: stale.cachedAt,
          expiresAt: stale.expiresAt,
        },
      };
    }
    throw error;
  }
  const now = new Date();
  const envelope: CacheEnvelope<T> = {
    value,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.ttlSeconds * 1000).toISOString(),
  };
  await writeJson(env, key, envelope).catch((error) => {
    console.warn(`Cache write failed for ${key}`, error);
  });
  return {
    value,
    cache: {
      key,
      hit: false,
      cachedAt: envelope.cachedAt,
      expiresAt: envelope.expiresAt,
    },
  };
}

export async function readJson<T>(
  env: Env,
  key: string,
  options: { allowExpired?: boolean } = {},
): Promise<CacheEnvelope<T> | null> {
  const memory = memoryCache.get(key) as CacheEnvelope<T> | undefined;
  if (memory) {
    if (options.allowExpired || Date.parse(memory.expiresAt) > Date.now()) {
      memoryCache.delete(key);
      memoryCache.set(key, memory);
      return memory;
    }
    memoryCache.delete(key);
  }

  if (!env.CACHE_BUCKET) return null;
  const object = await env.CACHE_BUCKET.get(key);
  if (!object) return null;
  const envelope = (await object.json()) as CacheEnvelope<T>;
  if (!options.allowExpired && Date.parse(envelope.expiresAt) <= Date.now()) {
    return null;
  }
  return envelope;
}

export async function writeJson<T>(
  env: Env,
  key: string,
  envelope: CacheEnvelope<T>,
): Promise<void> {
  memoryCache.delete(key);
  memoryCache.set(key, envelope);
  pruneMemoryCache();
  if (!env.CACHE_BUCKET) return;
  await env.CACHE_BUCKET.put(key, JSON.stringify(envelope), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      cachedAt: envelope.cachedAt,
      expiresAt: envelope.expiresAt,
    },
  });
}

function pruneMemoryCache(): void {
  const now = Date.now();
  for (const [key, envelope] of memoryCache) {
    if (Date.parse(envelope.expiresAt) <= now) memoryCache.delete(key);
  }
  while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

export function cacheKey(
  parts: Array<string | number | boolean | undefined | null>,
): string {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map((part) => encodeURIComponent(String(part)))
    .join("/");
}

export async function cleanupExpiredCacheObjects(
  env: Env,
  options: { maxDeletes?: number; staleRetentionSeconds?: number } = {},
): Promise<{
  scanned: number;
  deleted: number;
  truncated: boolean;
}> {
  if (!env.CACHE_BUCKET) return { scanned: 0, deleted: 0, truncated: false };

  const maxDeletes = options.maxDeletes ?? MAX_DELETE_BATCH_SIZE;
  const staleRetentionMs =
    (options.staleRetentionSeconds ?? DEFAULT_STALE_RETENTION_SECONDS) * 1000;
  let cursor: string | undefined;
  let scanned = 0;
  let deleted = 0;
  let truncated = false;

  do {
    const listed = await env.CACHE_BUCKET.list({
      cursor,
      include: ["customMetadata"],
      limit: MAX_DELETE_BATCH_SIZE,
    });
    scanned += listed.objects.length;

    const expiredKeys = listed.objects
      .filter((object) =>
        isPastStaleRetention(object.customMetadata?.expiresAt, staleRetentionMs),
      )
      .map((object) => object.key)
      .slice(0, maxDeletes - deleted);

    if (expiredKeys.length > 0) {
      await env.CACHE_BUCKET.delete(expiredKeys);
      deleted += expiredKeys.length;
      for (const key of expiredKeys) memoryCache.delete(key);
    }

    truncated = listed.truncated;
    cursor = listed.cursor;
  } while (truncated && deleted < maxDeletes);

  return { scanned, deleted, truncated };
}

function isPastStaleRetention(
  expiresAt: string | undefined,
  staleRetentionMs: number,
): boolean {
  return (
    expiresAt != null && Date.parse(expiresAt) + staleRetentionMs <= Date.now()
  );
}
