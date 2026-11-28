import { bangumiToken } from "./auth";
import { matchesEtag } from "./cache";
import {
  getHeat,
  getSchedule,
  getSeason,
  getSubjectAliases,
  getTodaySchedule,
  refreshLive,
  refreshMaterializedCaches,
} from "./catalogue";
import { danmakuQuota, listDanmaku, sendDanmaku } from "./danmaku";
import { edgeCached } from "./edge";
import { docsHtml, openApiSpec } from "./openapi";
import { sourceRules } from "./sources";
import { deleteSettings, getSettings, putSettings } from "./sync";
import { HttpError, type Env } from "./types";
import { boolParam, errorJson, json, preflightResponse, requireAdmin } from "./utils";

// wrangler.toml's crons: the daily one refreshes season lists and
// bangumi-data, the 15-minute one heat and the schedules clients open.
const DAILY_CRON = "0 16 * * *";

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
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(event.cron === DAILY_CRON ? refreshMaterializedCaches(env) : refreshLive(env));
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
  const force = request.method === "GET" && boolParam(url.searchParams.get("force"));
  if (force) {
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
  if (path === "v1/sync/settings" && request.method === "GET")
    return getSettings(request, env);
  if (path === "v1/sync/settings" && request.method === "PUT")
    return putSettings(request, env);
  if (path === "v1/sync/settings" && request.method === "DELETE")
    return deleteSettings(request, env);
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

  if (request.method === "GET") {
    const read = catalogueRead(path, url, env, ctx);
    if (read) return edgeCached(url, ctx, force, read);
  }
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

/** The catalogue reads, which the edge keeps while fresh. */
function catalogueRead(
  path: string,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): (() => Promise<Response>) | undefined {
  if (/^v1\/subjects\/\d+\/aliases$/.test(path))
    return () => getSubjectAliases(Number(path.split("/")[2]), url, env, ctx);
  if (path === "v1/schedule/latest") return () => getSchedule(url, env, ctx);
  if (path === "v1/schedule/today") return () => getTodaySchedule(url, env, ctx);
  if (path === "v1/schedule/heat") return () => getHeat(url, env, ctx);
  if (path === "v1/seasons/current") return () => getSeason(url, env, "current", ctx);
  if (path === "v1/trending/current") return () => getSeason(url, env, "trending", ctx);
  return undefined;
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}
