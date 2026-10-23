import { bangumiToken } from "./auth";
import { BangumiClient } from "./bangumi";
import { cacheKey, cacheHeaders, cleanupExpiredCacheObjects, getOrSetJson, matchesEtag, queryCacheKey, waitForCacheLoad, writeJson, type CacheResult } from "./cache";
import { danmakuQuota, listDanmaku, sendDanmaku } from "./danmaku";
import { docsHtml, openApiSpec } from "./openapi";
import { sourceRules } from "./sources";
import { loadSeasonCatalogue } from "./seasons";
import {
  buildScheduleResponse,
  loadSubjectAliases,
  loadBangumiData,
} from "./schedule";
import { HttpError, type Env, type ScheduleResponse } from "./types";
import {
  boolParam,
  clampInt,
  currentShanghaiDate,
  dateParam,
  errorJson,
  json,
  parseSeason,
  preflightResponse,
  requireAdmin,
  seasonDateRange,
} from "./utils";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") return preflightResponse();
    try {
      const response = await route(request, env, ctx);
      const etag = response.headers.get("etag");
      if (request.method === "GET" && response.status === 200 && etag && matchesEtag(request, etag)) {
        await response.body?.cancel();
        return new Response(null, { status: 304, headers: response.headers });
      }
      return response;
    } catch (error) {
      console.error(error);
      const maybeHttp = error as HttpError;
      if (typeof maybeHttp.status === "number") {
        const response = errorJson(
          maybeHttp.status,
          maybeHttp.code,
          maybeHttp.message,
          maybeHttp.details,
        );
        if (maybeHttp.retryAfter) response.headers.set("retry-after", maybeHttp.retryAfter);
        return response;
      }
      return errorJson(
        error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name) ? 504 : 500,
        error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name) ? "UPSTREAM_TIMEOUT" : "INTERNAL_ERROR",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(refreshMaterializedCaches(env));
  },
};

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = trimPath(url.pathname);
  const id = /^v1\/subjects\/(\d+)(?:\/|$)/.exec(path)?.[1];
  if (id && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new HttpError(400, "INVALID_PARAMETER", "Resource IDs must be positive safe integers.");
  }
  if (request.method === "GET" && boolParam(url.searchParams.get("force"))) {
    const rejected = requireAdmin(request, env);
    if (rejected) return rejected;
  }

  if (path === "")
    return json({ name: "melon-api", docs: "/docs", openapi: "/openapi.json" });
  if (path === "health")
    return json({ ok: true, now: new Date().toISOString() });
  if (path === "sources/rules" && request.method === "GET")
    return sourceRules(request, url);
  if (path === "v1/auth/bangumi/token" && request.method === "POST")
    return bangumiToken(request, env);
  if (path === "v1/danmaku/quota" && request.method === "GET")
    return danmakuQuota(request, env);
  const episode = /^v1\/danmaku\/([^/]+)$/.exec(path)?.[1];
  if (episode && request.method === "GET") return listDanmaku(request, env, episode);
  if (episode && request.method === "POST") return sendDanmaku(request, env, episode);
  if (path === "docs") {
    return new Response(docsHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  if (path === "openapi.json")
    return json(openApiSpec(env.PUBLIC_BASE_URL ?? url.origin), {
      headers: { "cache-control": "public, max-age=3600" },
    });

  if (request.method === "GET" && /^v1\/subjects\/\d+\/aliases$/.test(path))
    return getSubjectAliases(Number(path.split("/")[2]), url, env, ctx);
  if (request.method === "GET" && path === "v1/schedule/latest")
    return getSchedule(url, env, ctx);
  if (request.method === "GET" && path === "v1/schedule/today")
    return getTodaySchedule(url, env, ctx);
  if (request.method === "GET" && path === "v1/seasons/current")
    return getSeason(url, env, "current", ctx);
  if (request.method === "GET" && path === "v1/trending/current")
    return getSeason(url, env, "trending", ctx);
  if (request.method === "POST" && path === "v1/internal/refresh") {
    const rejected = requireAdmin(request, env);
    if (rejected) return rejected;
    ctx.waitUntil(refreshMaterializedCaches(env));
    return json(
      { accepted: true, startedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return errorJson(404, "NOT_FOUND", `No route for ${request.method} /${path}`);
}

async function getSchedule(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const view = url.searchParams.get("view") ?? "both";
  if (!["both", "items", "byDate"].includes(view)) throw new HttpError(400, "INVALID_PARAMETER", "Unknown schedule view.");
  const result = await getScheduleCached(url, env, false, ctx);
  const { items, ...metadata } = result.value;
  const byDate: NonNullable<ScheduleResponse["byDate"]> = {};
  if (view !== "items") {
    for (const item of items) (byDate[item.airingAtShanghai.slice(0, 10)] ??= []).push(item);
  }
  const cache = { ...result.cache, etag: `${result.cache.etag.slice(0, -1)}-${view}"` };
  return cachedJson({ ...metadata, ...(view !== "byDate" ? { items } : {}), ...(view !== "items" ? { byDate } : {}), cache }, cache);
}

async function getTodaySchedule(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const schedule = await getScheduleCached(url, env, false, ctx, 0);
  const today = currentShanghaiDate();
  return cachedJson({
    generatedAt: schedule.value.generatedAt,
    date: today,
    items: schedule.value.items.filter((item) => item.airingAtShanghai.startsWith(today)),
    cache: schedule.cache,
  }, schedule.cache);
}

async function getSeason(
  url: URL,
  env: Env,
  mode: "current" | "trending",
  ctx: ExecutionContext,
): Promise<Response> {
  const season = parseSeason(url.searchParams.get("season"));
  const range = seasonDateRange(season);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 5000);
  const sort = mode === "trending" ? "heat" : url.searchParams.get("sort") ?? "rank";
  if (sort !== "heat" && sort !== "rank") throw new HttpError(400, "INVALID_PARAMETER", "Season lists sort by heat or rank.");
  const result = await loadSeasonCatalogue(env, season, sort, boolParam(url.searchParams.get("includeNsfw")),
    boolParam(url.searchParams.get("force")), (task) => ctx.waitUntil(task));
  const cache = { ...result.cache, etag: `${result.cache.etag.slice(0, -1)}-${mode}-${limit}-${offset}"` };
  const total = result.value.total;
  return cachedJson({
    season, range, total, limit, offset,
    hasMore: offset + limit < total && offset + limit <= 5000,
    data: result.value.data.slice(offset, offset + limit), cache,
  }, cache);
}

async function getSubjectAliases(
  subjectId: number,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const background = (task: Promise<unknown>) => ctx.waitUntil(task);
  const result = await getOrSetJson(env, cacheKey(["subjects", subjectId, "aliases-v1"]),
    { ttlSeconds: 24 * 60 * 60, force },
    () => loadSubjectAliases(env, subjectId, force, background), background);
  return cachedJson({ data: result.value, cache: result.cache }, result.cache);
}

async function refreshMaterializedCaches(env: Env): Promise<void> {
  const current = parseSeason(null);
  const previous = parseSeason(current.quarter === 1
    ? `${current.year - 1}Q4` : `${current.year}Q${current.quarter - 1}`);
  const client = new BangumiClient(env);
  await Promise.all([
    ...[current, previous].flatMap((season) => [
      loadSeasonCatalogue(env, season, "heat", false, true),
      loadSeasonCatalogue(env, season, "rank", false, true),
      loadSeasonCatalogue(env, season, "rank", true, true),
    ]),
    loadBangumiData(env, true),
    getOrSetJson(env, "source/calendar", { ttlSeconds: 3600, force: true }, () => client.getCalendarSubjects()),
  ]);
  const origin = new URL("https://melon-api.local");
  const weekUrl = new URL(`https://melon-api.local?startDate=${currentShanghaiDate()}&dayCount=7`);
  await Promise.all([
    getScheduleCached(origin, env, true, undefined, 0),
    getScheduleCached(origin, env, true),
    getScheduleCached(weekUrl, env, true),
    cleanupExpiredCacheObjects(env).catch((error) => {
      console.warn("Expired cache cleanup failed", error);
      return { scanned: 0, deleted: 0, truncated: false };
    }),
  ]);
}

async function getScheduleCached(
  url: URL,
  env: Env,
  forceOverride = false,
  ctx?: ExecutionContext,
  defaultDays = 7,
): Promise<Awaited<ReturnType<typeof getOrSetJson<ScheduleResponse>>>> {
  const days = clampInt(url.searchParams.get("days"), defaultDays, 0, 31);
  const date = dateParam(url.searchParams.get("date"));
  const startDate = url.searchParams.has("startDate") ? dateParam(url.searchParams.get("startDate")) : undefined;
  if (!startDate && url.searchParams.has("dayCount")) throw new HttpError(400, "INVALID_PARAMETER", "dayCount requires startDate.");
  const dayCount = startDate ? clampInt(url.searchParams.get("dayCount"), 7, 1, 63) : undefined;
  const requireBroadcast = boolParam(url.searchParams.get("requireBroadcast"));
  const includeNsfw = boolParam(url.searchParams.get("includeNsfw"));
  const includeUnknownNsfw = boolParam(url.searchParams.get("includeUnknownNsfw"), true);
  const force = boolParam(url.searchParams.get("force"));
  const key = queryCacheKey("schedule-v3", { ...(startDate ? { startDate, dayCount } : { date, days }), requireBroadcast, includeNsfw, includeUnknownNsfw });
  return getOrSetJson(
    env,
    key,
    {
      ttlSeconds: 24 * 60 * 60,
      force: forceOverride || force,
      staleWhileRevalidateSeconds: 24 * 60 * 60,
    },
    () =>
      buildScheduleResponse(
        env,
        { days, date, startDate, dayCount, force, requireBroadcast, includeNsfw, includeUnknownNsfw },
        ctx ? (task) => ctx.waitUntil(task) : undefined,
        ctx ? async (value) => {
          await waitForCacheLoad(key);
          const now = Date.now();
          await writeJson(env, key, { value, cachedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 86400 * 1000).toISOString() });
        } : undefined,
      ),
    ctx ? (task) => ctx.waitUntil(task) : undefined,
  );
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function cachedJson(data: unknown, cache: CacheResult<unknown>["cache"], headers: Record<string, string> = {}): Response {
  return json(data, { headers: { ...cacheHeaders(cache), ...headers } });
}
