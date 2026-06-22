import type { CachePolicy, Env } from "./types";

type CacheEnvelope<T> = {
  value: T;
  cachedAt: string;
  expiresAt: string;
};

const memoryCache = new Map<string, CacheEnvelope<unknown>>();
const MAX_MEMORY_CACHE_ENTRIES = 256;

export async function getOrSetJson<T>(
  env: Env,
  key: string,
  policy: CachePolicy,
  loader: () => Promise<T>
): Promise<{ value: T; cache: { key: string; hit: boolean; cachedAt: string; expiresAt: string } }> {
  if (!policy.force) {
    const cached = await readJson<T>(env, key).catch((error) => {
      console.warn(`Cache read failed for ${key}`, error);
      return null;
    });
    if (cached && Date.parse(cached.expiresAt) > Date.now()) {
      return {
        value: cached.value,
        cache: { key, hit: true, cachedAt: cached.cachedAt, expiresAt: cached.expiresAt }
      };
    }
  }

  const value = await loader();
  const now = new Date();
  const envelope: CacheEnvelope<T> = {
    value,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.ttlSeconds * 1000).toISOString()
  };
  await writeJson(env, key, envelope).catch((error) => {
    console.warn(`Cache write failed for ${key}`, error);
  });
  return {
    value,
    cache: { key, hit: false, cachedAt: envelope.cachedAt, expiresAt: envelope.expiresAt }
  };
}

export async function readJson<T>(env: Env, key: string): Promise<CacheEnvelope<T> | null> {
  const memory = memoryCache.get(key) as CacheEnvelope<T> | undefined;
  if (memory) {
    if (Date.parse(memory.expiresAt) > Date.now()) {
      memoryCache.delete(key);
      memoryCache.set(key, memory);
      return memory;
    }
    memoryCache.delete(key);
  }

  if (!env.CACHE_BUCKET) return null;
  const object = await env.CACHE_BUCKET.get(key);
  if (!object) return null;
  return (await object.json()) as CacheEnvelope<T>;
}

export async function writeJson<T>(env: Env, key: string, envelope: CacheEnvelope<T>): Promise<void> {
  memoryCache.delete(key);
  memoryCache.set(key, envelope);
  pruneMemoryCache();
  if (!env.CACHE_BUCKET) return;
  await env.CACHE_BUCKET.put(key, JSON.stringify(envelope), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8"
    },
    customMetadata: {
      cachedAt: envelope.cachedAt,
      expiresAt: envelope.expiresAt
    }
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

export function cacheKey(parts: Array<string | number | boolean | undefined | null>): string {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map((part) => encodeURIComponent(String(part)))
    .join("/");
}
