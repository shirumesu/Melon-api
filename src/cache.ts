import type { CachePolicy, Env } from "./types";

type CacheEnvelope<T> = {
  value: T;
  cachedAt: string;
  expiresAt: string;
};

type CacheResult<T> = {
  value: T;
  cache: {
    key: string;
    hit: boolean;
    cachedAt: string;
    expiresAt: string;
    stale?: boolean;
  };
};

const memoryCache = new Map<string, CacheEnvelope<unknown>>();
const pendingReads = new Map<string, Promise<CacheEnvelope<unknown> | null>>();
const pendingLoads = new Map<string, Promise<CacheEnvelope<unknown>>>();
const MAX_MEMORY_CACHE_ENTRIES = 256;
const MAX_DELETE_BATCH_SIZE = 1000;
const DEFAULT_STALE_RETENTION_SECONDS = 14 * 24 * 60 * 60;

export async function getOrSetJson<T>(
  env: Env,
  key: string,
  policy: CachePolicy<T>,
  loader: () => Promise<T>,
  background?: (task: Promise<unknown>) => void,
): Promise<CacheResult<T>> {
  let stale: CacheEnvelope<T> | null = null;
  if (!policy.force) {
    let cached = await readJson<T>(env, key, { allowExpired: true }).catch(
      (error) => {
        console.warn(`Cache read failed for ${key}`, error);
        return null;
      },
    );
    if (cached) {
      // Apply current policy to persisted envelopes too, including caches made
      // before incomplete responses had a shorter lifetime.
      if (typeof policy.ttlSeconds === "function") {
        cached = {
          ...cached,
          expiresAt: new Date(Math.min(
            Date.parse(cached.expiresAt),
            Date.parse(cached.cachedAt) + policy.ttlSeconds(cached.value) * 1000,
          )).toISOString(),
        };
      }
      if (Date.parse(cached.expiresAt) > Date.now()) {
        return result(key, cached, true);
      }
      stale = cached;
    }
  }

  if (
    stale &&
    background &&
    (policy.canServeStale?.(stale.value) ?? true) &&
    policy.staleWhileRevalidateSeconds &&
    Date.now() - Date.parse(stale.expiresAt) <=
      policy.staleWhileRevalidateSeconds * 1000
  ) {
    background(
      loadFresh(env, key, policy, loader, background).catch((error) => {
        console.warn(`Background refresh failed for ${key}`, error);
      }),
    );
    return result(key, stale, true, true);
  }
  try {
    const fresh = await loadFresh(env, key, policy, loader, background);
    return result(key, fresh, false);
  } catch (error) {
    if (stale) {
      console.warn(`Loader failed for ${key}; returning stale cache`, error);
      return result(key, stale, true, true);
    }
    throw error;
  }
}

function result<T>(
  key: string,
  envelope: CacheEnvelope<T>,
  hit: boolean,
  stale = false,
): CacheResult<T> {
  return {
    value: envelope.value,
    cache: {
      key,
      hit,
      cachedAt: envelope.cachedAt,
      expiresAt: envelope.expiresAt,
      ...(stale ? { stale: true } : {}),
    },
  };
}

async function loadFresh<T>(
  env: Env,
  key: string,
  policy: CachePolicy<T>,
  loader: () => Promise<T>,
  background?: (task: Promise<unknown>) => void,
): Promise<CacheEnvelope<T>> {
  const pending = pendingLoads.get(key);
  if (pending) return pending as Promise<CacheEnvelope<T>>;
  const loading = (async () => {
    const value = await loader();
    const now = new Date();
    const ttl = typeof policy.ttlSeconds === "function"
      ? policy.ttlSeconds(value)
      : policy.ttlSeconds;
    const envelope = {
      value,
      cachedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    };
    const writing = writeJson(env, key, envelope).catch((error) => {
      console.warn(`Cache write failed for ${key}`, error);
    });
    if (background && env.CACHE_BUCKET) background(writing);
    else await writing;
    return envelope;
  })();
  pendingLoads.set(key, loading);
  try {
    return await loading;
  } finally {
    pendingLoads.delete(key);
  }
}

export async function readJson<T>(
  env: Env,
  key: string,
  options: { allowExpired?: boolean } = {},
): Promise<CacheEnvelope<T> | null> {
  let envelope = memoryCache.get(key) as CacheEnvelope<T> | undefined | null;
  if (!envelope && env.CACHE_BUCKET) {
    let pending = pendingReads.get(key);
    if (!pending) {
      pending = (async () => {
        const object = await env.CACHE_BUCKET!.get(key);
        if (!object) return null;
        const stored = await object.json<CacheEnvelope<T>>();
        const newer = memoryCache.get(key);
        if (newer && Date.parse(newer.cachedAt) > Date.parse(stored.cachedAt)) {
          return newer;
        }
        remember(key, stored);
        return stored;
      })();
      pendingReads.set(key, pending);
    }
    try {
      envelope = (await pending) as CacheEnvelope<T> | null;
    } finally {
      pendingReads.delete(key);
    }
  }
  if (!envelope) return null;
  if (!options.allowExpired && Date.parse(envelope.expiresAt) <= Date.now()) {
    return null;
  }
  remember(key, envelope);
  return envelope;
}

export async function writeJson<T>(
  env: Env,
  key: string,
  envelope: CacheEnvelope<T>,
): Promise<void> {
  remember(key, envelope);
  if (!env.CACHE_BUCKET) return;
  await env.CACHE_BUCKET.put(key, JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { cachedAt: envelope.cachedAt, expiresAt: envelope.expiresAt },
  });
}

function remember(key: string, envelope: CacheEnvelope<unknown>): void {
  memoryCache.delete(key);
  memoryCache.set(key, envelope);
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
