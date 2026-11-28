import { BangumiClient } from "./bangumi";
import { loadBangumiData, loadSubjectAliases } from "./bangumi_data";
import { cacheKey, cleanupExpiredCacheObjects, getOrSetJson, queryCacheKey } from "./cache";
import { cachedJson } from "./edge";
import { HEAT_WEEKS_BACK, loadWeekHeat } from "./heat";
import { buildScheduleResponse } from "./schedule";
import { addWeeks, CRON_INTERVAL_SECONDS, FetchBudget, weekOf, type RefreshMode } from "./schedule_subjects";
import { loadSeasonCatalogue } from "./seasons";
import { HttpError, type Env, type ScheduleResponse } from "./types";
import { boolParam, clampInt, currentShanghaiDate, dateParam, parseSeason, seasonDateRange } from "./utils";

/**
 * Bangumi requests a request and a cron run may make of the 50 external
 * requests Workers Free allows an invocation; the rest covers bangumi-data
 * (up to three mirrors) and Bangumi's calendar.
 */
const REQUEST_BUDGET = 30;
const CRON_BUDGET = 40;

export async function getSchedule(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const view = url.searchParams.get("view") ?? "both";
  if (!["both", "items", "byDate"].includes(view)) throw new HttpError(400, "INVALID_PARAMETER", "Unknown schedule view.");
  const result = await getScheduleCached(url, env, { ctx });
  const { items, ...metadata } = result.value;
  const byDate: NonNullable<ScheduleResponse["byDate"]> = {};
  if (view !== "items") {
    for (const item of items) (byDate[item.airingAtShanghai.slice(0, 10)] ??= []).push(item);
  }
  const cache = { ...result.cache, etag: `${result.cache.etag.slice(0, -1)}-${view}"` };
  return cachedJson({ ...metadata, ...(view !== "byDate" ? { items } : {}), ...(view !== "items" ? { byDate } : {}), cache }, cache);
}

export async function getTodaySchedule(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const schedule = await getScheduleCached(url, env, { ctx, defaultDays: 0 });
  const today = currentShanghaiDate();
  return cachedJson({
    generatedAt: schedule.value.generatedAt,
    date: today,
    items: schedule.value.items.filter((item) => item.airingAtShanghai.startsWith(today)),
    cache: schedule.cache,
  }, schedule.cache);
}

/** The heat of the week holding `week` (this one by default), for the weekly chart. */
export async function getHeat(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const current = weekOf(currentShanghaiDate());
  const week = weekOf(dateParam(url.searchParams.get("week"), current));
  if (week < addWeeks(current, -HEAT_WEEKS_BACK) || week > addWeeks(current, 1)) {
    throw new HttpError(400, "INVALID_PARAMETER", `Heat covers the ${HEAT_WEEKS_BACK} weeks before this one, this week and the next.`);
  }
  const result = await loadWeekHeat(env, week, new FetchBudget(REQUEST_BUDGET), "request", {
    force: boolParam(url.searchParams.get("force")),
    background: (task) => ctx.waitUntil(task),
  });
  return cachedJson({ ...result.value, cache: result.cache }, result.cache);
}

export async function getSeason(
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

export async function getSubjectAliases(subjectId: number, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const background = (task: Promise<unknown>) => ctx.waitUntil(task);
  const result = await getOrSetJson(env, cacheKey(["subjects", subjectId, "aliases-v1"]),
    { ttlSeconds: 24 * 60 * 60, force },
    () => loadSubjectAliases(env, subjectId, force, background), background);
  return cachedJson({ data: result.value, cache: result.cache }, result.cache);
}

/** The schedule a URL asks for, kept an hour, or a minute while some shows are incomplete. */
function getScheduleCached(
  url: URL,
  env: Env,
  options: { ctx?: ExecutionContext; defaultDays?: number; budget?: FetchBudget; mode?: RefreshMode },
) {
  const days = clampInt(url.searchParams.get("days"), options.defaultDays ?? 7, 0, 31);
  const date = dateParam(url.searchParams.get("date"));
  const startDate = url.searchParams.has("startDate") ? dateParam(url.searchParams.get("startDate")) : undefined;
  if (!startDate && url.searchParams.has("dayCount")) throw new HttpError(400, "INVALID_PARAMETER", "dayCount requires startDate.");
  const dayCount = startDate ? clampInt(url.searchParams.get("dayCount"), 7, 1, 63) : undefined;
  const requireBroadcast = boolParam(url.searchParams.get("requireBroadcast"));
  const includeNsfw = boolParam(url.searchParams.get("includeNsfw"));
  const includeUnknownNsfw = boolParam(url.searchParams.get("includeUnknownNsfw"), true);
  const force = boolParam(url.searchParams.get("force"));
  const mode = options.mode ?? "request";
  const background = options.ctx ? (task: Promise<unknown>) => options.ctx!.waitUntil(task) : undefined;
  const key = queryCacheKey("schedule-v4", {
    ...(startDate ? { startDate, dayCount } : { date, days }), requireBroadcast, includeNsfw, includeUnknownNsfw,
  });
  return getOrSetJson<ScheduleResponse>(
    env,
    key,
    {
      ttlSeconds: (value) => value.incomplete ? 60 : 60 * 60,
      force,
      staleWhileRevalidateSeconds: 24 * 60 * 60,
      refreshAheadSeconds: mode === "cron" ? CRON_INTERVAL_SECONDS : undefined,
    },
    () => buildScheduleResponse(
      env,
      { days, date, startDate, dayCount, force, requireBroadcast, includeNsfw, includeUnknownNsfw },
      options.budget ?? new FetchBudget(REQUEST_BUDGET),
      mode,
      background,
    ),
    background,
  );
}

/**
 * Every 15 minutes: this week's heat, then the schedules clients open, one
 * after another so they share a budget of Bangumi requests. Each refreshes
 * what falls due before the next run; what one fetches, the next reads.
 */
export async function refreshLive(env: Env): Promise<void> {
  const today = currentShanghaiDate();
  const monday = weekOf(today);
  const budget = new FetchBudget(CRON_BUDGET);
  await loadWeekHeat(env, monday, budget, "cron");
  for (const query of [`startDate=${monday}&dayCount=7`, `startDate=${today}&dayCount=7`, "days=0", `startDate=${addWeeks(monday, 1)}&dayCount=7`]) {
    await getScheduleCached(new URL(`https://melon-api.local?${query}`), env, { budget, mode: "cron" });
  }
}

/**
 * Daily: the season catalogues clients read, this season's trending and
 * list (each about nine Bangumi requests, as Bangumi returns 20 a page),
 * bangumi-data and the calendar, then old cache objects go.
 */
export async function refreshMaterializedCaches(env: Env): Promise<void> {
  const season = parseSeason(null);
  const client = new BangumiClient(env);
  const results = await Promise.allSettled([
    loadSeasonCatalogue(env, season, "heat", false, true),
    loadSeasonCatalogue(env, season, "rank", false, true),
    loadBangumiData(env, true),
    getOrSetJson(env, "source/calendar", { ttlSeconds: 60 * 60, force: true }, () => client.getCalendarSubjects()),
  ]);
  await cleanupExpiredCacheObjects(env);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Daily refresh incomplete");
}
