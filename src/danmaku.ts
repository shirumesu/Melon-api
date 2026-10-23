import { HttpError, type Env } from "./types";
import { json } from "./utils";

/**
 * MelonBanG's own danmaku, keyed by Bangumi episode ID. Anyone may read;
 * sending needs a Bangumi access token, which is checked against Bangumi
 * `/v0/me` and never stored: only the Bangumi user ID is kept with each
 * comment. A user may send one comment every 3 seconds and 200 a day
 * (Asia/Shanghai days).
 */

export const SEND_INTERVAL_SECONDS = 3;
export const DAILY_LIMIT = 200;
const MAX_LENGTH = 100;
const READ_CACHE_SECONDS = 30;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

type Row = { id: number; time_ms: number; mode: number; color: number; text: string };

function database(env: Env): D1Database {
  if (!env.DB) throw new HttpError(503, "NOT_CONFIGURED", "Danmaku storage is not configured.");
  return env.DB;
}

function episodeParam(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, "INVALID_PARAMETER", "Episode IDs must be positive safe integers.");
  }
  return id;
}

/** Comments of one episode in time order, cached at the edge briefly. */
export async function listDanmaku(request: Request, env: Env, episode: string | undefined): Promise<Response> {
  const id = episodeParam(episode);
  const cache = caches.default;
  const key = cacheRequest(request.url);
  const cached = await cache.match(key);
  if (cached) return cached;
  const { results } = await database(env)
    .prepare("SELECT id, time_ms, mode, color, text FROM danmaku WHERE episode = ? ORDER BY time_ms, id")
    .bind(id)
    .all<Row>();
  const response = json(
    {
      episode: id,
      data: results.map((row) => ({
        id: row.id,
        time: row.time_ms / 1000,
        mode: row.mode,
        color: row.color,
        text: row.text,
      })),
    },
    { headers: { "cache-control": `public, max-age=${READ_CACHE_SECONDS}` } },
  );
  await cache.put(key, response.clone());
  return response;
}

/** How many comments the signed-in user may still send today. */
export async function danmakuQuota(request: Request, env: Env): Promise<Response> {
  const user = await bangumiUser(request, env);
  return json(await quota(database(env), user), { headers: { "cache-control": "no-store" } });
}

export async function sendDanmaku(
  request: Request,
  env: Env,
  episode: string | undefined,
): Promise<Response> {
  const id = episodeParam(episode);
  const db = database(env);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const text = typeof body?.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  const time = Number(body?.time);
  const mode = Number(body?.mode ?? 1);
  const color = Number(body?.color ?? 0xffffff);
  if (!text || [...text].length > MAX_LENGTH) {
    throw new HttpError(400, "INVALID_PARAMETER", `Text must be 1–${MAX_LENGTH} characters.`);
  }
  if (!Number.isFinite(time) || time < 0 || time > 24 * 60 * 60) {
    throw new HttpError(400, "INVALID_PARAMETER", "Time must be seconds within the video.");
  }
  if (![1, 4, 5].includes(mode)) throw new HttpError(400, "INVALID_PARAMETER", "Mode must be 1, 4 or 5.");
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
    throw new HttpError(400, "INVALID_PARAMETER", "Color must be an RGB integer.");
  }
  const user = await bangumiUser(request, env);
  const before = await quota(db, user);
  if (before.remaining <= 0) {
    throw new HttpError(429, "DAILY_LIMIT", `每天最多发送 ${DAILY_LIMIT} 条弹幕`, before, String(before.resetIn));
  }
  if (before.waitSeconds > 0) {
    throw new HttpError(429, "TOO_FAST", `${before.waitSeconds} 秒后才能再发送`, before, String(before.waitSeconds));
  }
  const now = Date.now();
  const result = await db
    .prepare("INSERT INTO danmaku (episode, time_ms, mode, color, text, user, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, Math.round(time * 1000), mode, color, text, user, now)
    .run();
  await caches.default.delete(cacheRequest(new URL(`/v1/danmaku/${id}`, request.url).toString()));
  return json(
    {
      id: result.meta.last_row_id,
      remaining: before.remaining - 1,
      limit: DAILY_LIMIT,
      waitSeconds: SEND_INTERVAL_SECONDS,
      resetIn: before.resetIn,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

type Quota = { limit: number; remaining: number; waitSeconds: number; resetIn: number };

async function quota(db: D1Database, user: number): Promise<Quota> {
  const now = Date.now();
  const dayStart = Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
  const row = await db
    .prepare("SELECT COUNT(*) AS sent, MAX(created) AS last FROM danmaku WHERE user = ? AND created >= ?")
    .bind(user, dayStart)
    .first<{ sent: number; last: number | null }>();
  const sent = row?.sent ?? 0;
  const since = row?.last == null ? Infinity : (now - row.last) / 1000;
  return {
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - sent),
    waitSeconds: Math.max(0, Math.ceil(SEND_INTERVAL_SECONDS - since)),
    resetIn: Math.ceil((dayStart + DAY - now) / 1000),
  };
}

/** The Bangumi user ID behind the request's bearer token. */
async function bangumiUser(request: Request, env: Env): Promise<number> {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) throw new HttpError(401, "UNAUTHORIZED", "请先登录 Bangumi");
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
  return id;
}

/** The edge cache entry of an episode's list: path only, GET. */
function cacheRequest(address: string): Request {
  const url = new URL(address);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}
