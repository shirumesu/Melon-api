import { HttpError, type Env } from "./types";

/** How long a checked token's user ID is remembered at the edge. */
const USER_CACHE_SECONDS = 600;

/**
 * The Bangumi user ID behind the request's bearer token, checked against
 * Bangumi `/v0/me`. The token is never stored: the edge remembers only the
 * user ID for a few minutes, under a SHA-256 hash of the token, so a client
 * syncing repeatedly does not ask Bangumi each time.
 */
export async function bangumiUser(request: Request, env: Env): Promise<number> {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) throw new HttpError(401, "UNAUTHORIZED", "请先登录 Bangumi");
  const key = await cacheKey(token);
  const cached = await caches.default.match(key).catch(() => undefined);
  if (cached) {
    const id = Number(await cached.text());
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  const response = await fetch(`${env.BANGUMI_API_BASE ?? "https://api.bgm.tv"}/v0/me`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": env.BANGUMI_USER_AGENT ?? "melon-api",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "UNAUTHORIZED", "Bangumi 登录已失效，请重新登录");
  }
  if (!response.ok) throw new HttpError(502, "UPSTREAM_ERROR", `Bangumi 返回 ${response.status}`);
  const id = Number(((await response.json()) as { id?: unknown }).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(502, "UPSTREAM_ERROR", "Bangumi 未返回用户");
  await caches.default
    .put(key, new Response(String(id), { headers: { "cache-control": `max-age=${USER_CACHE_SECONDS}` } }))
    .catch(() => undefined);
  return id;
}

async function cacheKey(token: string): Promise<Request> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`https://melon-api.internal/bangumi-user/${hex}`, { method: "GET" });
}
