import { cacheHeaders, type CacheResult } from "./cache";
import { currentShanghaiDate, json } from "./utils";

/** Bumped when a cached response's shape changes, so the edge drops the old ones. */
const EDGE_VERSION = 1;

/**
 * Answers a computed catalogue read from the edge cache while it is fresh,
 * skipping R2 and the JSON work of rebuilding it; [respond] builds it
 * otherwise, and a fresh answer is kept until it expires. Keys carry the
 * day in Shanghai, which reads without a date default to.
 */
export async function edgeCached(
  url: URL,
  ctx: ExecutionContext,
  force: boolean,
  respond: () => Promise<Response>,
): Promise<Response> {
  const key = edgeKey(url);
  if (!force) {
    const hit = await caches.default.match(key);
    if (hit) return hit;
  }
  const response = await respond();
  const fresh = Math.floor((Date.parse(response.headers.get("x-cache-expires-at") ?? "") - Date.now()) / 1000);
  if (response.status === 200 && response.headers.get("x-cache-stale") !== "true" && fresh > 0) {
    response.headers.set("cache-control", `public, max-age=${fresh}`);
    ctx.waitUntil(caches.default.put(key, response.clone()));
  }
  return response;
}

function edgeKey(url: URL): Request {
  const key = new URL(`${url.origin}/__edge/${EDGE_VERSION}/${currentShanghaiDate()}${url.pathname}`);
  const params: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    if (name !== "force") params.push([name, value]);
  });
  params.sort(([a], [b]) => a.localeCompare(b));
  for (const [name, value] of params) key.searchParams.append(name, value);
  return new Request(key.toString());
}

/** [data] with the freshness of the cache entry it came from. */
export function cachedJson(data: unknown, cache: CacheResult<unknown>["cache"]): Response {
  return json(data, { headers: cacheHeaders(cache) });
}
