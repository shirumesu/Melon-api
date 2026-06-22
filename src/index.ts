import { BangumiClient, type SearchInput } from "./bangumi";
import { cacheKey, cleanupExpiredCacheObjects, getOrSetJson } from "./cache";
import {
  fetchEpisodeComments,
  fetchSubjectComments,
  fetchSubjectTopics,
} from "./html";
import { docsHtml, openApiSpec } from "./openapi";
import {
  buildScheduleResponse,
  fallbackScheduleFromAirDate,
  scheduleForSubject,
} from "./schedule";
import type { Env, HttpError, ScheduleResponse, SubjectDetail } from "./types";
import {
  boolParam,
  clampInt,
  currentShanghaiDate,
  errorJson,
  json,
  parseSeason,
  preflightResponse,
  readListParam,
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
      return await route(request, env, ctx);
    } catch (error) {
      console.error(error);
      const maybeHttp = error as HttpError;
      if (typeof maybeHttp.status === "number") {
        return errorJson(
          maybeHttp.status,
          maybeHttp.code,
          maybeHttp.message,
          maybeHttp.details,
        );
      }
      return errorJson(
        500,
        "INTERNAL_ERROR",
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
  if (request.method === "GET" && boolParam(url.searchParams.get("force"))) {
    const rejected = requireAdmin(request, env);
    if (rejected) return rejected;
  }

  if (path === "")
    return json({ name: "melon-api", docs: "/docs", openapi: "/openapi.json" });
  if (path === "health")
    return json({ ok: true, now: new Date().toISOString() });
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

  if (request.method === "GET" && path === "v1/subjects/search")
    return searchSubjects(url, env);
  if (request.method === "GET" && /^v1\/subjects\/\d+$/.test(path)) {
    return getSubject(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/subjects\/\d+\/episodes$/.test(path)) {
    return getSubjectEpisodes(Number(path.split("/")[2]), url, env);
  }
  if (
    request.method === "GET" &&
    /^v1\/subjects\/\d+\/characters$/.test(path)
  ) {
    return getSubjectCharacters(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/subjects\/\d+\/staff$/.test(path)) {
    return getSubjectStaff(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/subjects\/\d+\/comments$/.test(path)) {
    return getSubjectComments(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/subjects\/\d+\/topics$/.test(path)) {
    return getSubjectTopics(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/episodes\/\d+$/.test(path)) {
    return getEpisode(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/episodes\/\d+\/comments$/.test(path)) {
    return getEpisodeComments(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && path === "v1/schedule/latest")
    return getSchedule(url, env);
  if (request.method === "GET" && path === "v1/schedule/today")
    return getTodaySchedule(url, env);
  if (request.method === "GET" && path === "v1/seasons/current")
    return getSeason(url, env, "current");
  if (request.method === "GET" && path === "v1/trending/current")
    return getSeason(url, env, "trending");
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

async function searchSubjects(url: URL, env: Env): Promise<Response> {
  const client = new BangumiClient(env);
  const input = searchInputFromUrl(url);
  const force = boolParam(url.searchParams.get("force"));
  const key = cacheKey([
    "search",
    input.q,
    input.sort,
    input.limit,
    input.offset,
    input.tags.join(","),
    input.metaTags.join(","),
    input.airDates.join(","),
    input.ratings.join(","),
    input.ranks.join(","),
    input.includeNsfw,
  ]);
  const result = await getOrSetJson(
    env,
    key,
    { ttlSeconds: 30 * 60, force },
    () => client.searchSubjects(input),
  );
  return json({ ...result.value, cache: result.cache });
}

async function getSubject(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const full = !["0", "false"].includes(url.searchParams.get("full") ?? "");
  const force = boolParam(url.searchParams.get("force"));
  const key = cacheKey(["subjects", subjectId, full ? "full" : "brief"]);
  const result = await getOrSetJson(
    env,
    key,
    { ttlSeconds: full ? 6 * 60 * 60 : 60 * 60, force },
    async () => {
      const client = new BangumiClient(env);
      if (!full) return client.getSubject(subjectId);

      const subject = await client.getSubjectRaw(subjectId);
      const notes: string[] = [];
      const [
        episodes,
        characters,
        staff,
        relatedSubjects,
        comments,
        topics,
        schedule,
      ] = await Promise.all([
        client.getEpisodes(subjectId).catch((error) => {
          notes.push(note("episodes", error));
          return [];
        }),
        client.getCharacters(subjectId).catch((error) => {
          notes.push(note("characters", error));
          return [];
        }),
        client.getPersons(subjectId).catch((error) => {
          notes.push(note("staff", error));
          return [];
        }),
        client.getRelatedSubjects(subjectId).catch((error) => {
          notes.push(note("relatedSubjects", error));
          return [];
        }),
        fetchSubjectComments(env, subjectId).catch((error) => {
          notes.push(note("commentsHtml", error));
          return [];
        }),
        fetchSubjectTopics(env, subjectId).catch((error) => {
          notes.push(note("topicsHtml", error));
          return [];
        }),
        getScheduleValue(url, env).catch((error) => {
          notes.push(note("schedule", error));
          return null;
        }),
      ]);

      const detail: SubjectDetail = client.mapSubjectDetail(subject, {
        episodes,
        characters,
        staff,
        relatedSubjects,
        comments,
        topics,
        notes,
      });
      detail.schedule = schedule
        ? (scheduleForSubject(schedule.items, subjectId) ??
          fallbackScheduleFromAirDate(detail.airDate))
        : fallbackScheduleFromAirDate(detail.airDate);
      return detail;
    },
  );
  return json({ data: result.value, cache: result.cache });
}

async function getSubjectEpisodes(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const client = new BangumiClient(env);
  const result = await getOrSetJson(
    env,
    cacheKey(["subjects", subjectId, "episodes"]),
    { ttlSeconds: 6 * 60 * 60, force },
    () => client.getEpisodes(subjectId),
  );
  return json({ data: result.value, cache: result.cache });
}

async function getSubjectCharacters(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const client = new BangumiClient(env);
  const result = await getOrSetJson(
    env,
    cacheKey(["subjects", subjectId, "characters"]),
    { ttlSeconds: 24 * 60 * 60, force },
    () => client.getCharacters(subjectId),
  );
  return json({ data: result.value, cache: result.cache });
}

async function getSubjectStaff(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const client = new BangumiClient(env);
  const result = await getOrSetJson(
    env,
    cacheKey(["subjects", subjectId, "staff"]),
    { ttlSeconds: 24 * 60 * 60, force },
    () => client.getPersons(subjectId),
  );
  return json({ data: result.value, cache: result.cache });
}

async function getSubjectComments(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const result = await getOrSetJson(
    env,
    cacheKey(["subjects", subjectId, "comments"]),
    { ttlSeconds: 30 * 60, force },
    () => fetchSubjectComments(env, subjectId),
  );
  return json({
    data: result.value,
    source: {
      provider: "bangumi-web",
      available: result.value.length > 0,
      note: "Bangumi official v0 API does not expose subject comments; this endpoint parses public HTML best-effort.",
    },
    cache: result.cache,
  });
}

async function getSubjectTopics(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const result = await getOrSetJson(
    env,
    cacheKey(["subjects", subjectId, "topics"]),
    { ttlSeconds: 30 * 60, force },
    () => fetchSubjectTopics(env, subjectId),
  );
  return json({
    data: result.value,
    source: {
      provider: "bangumi-web",
      available: result.value.length > 0,
      note: "Bangumi official v0 API does not expose subject board topics; this endpoint parses public HTML best-effort.",
    },
    cache: result.cache,
  });
}

async function getEpisode(
  episodeId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const client = new BangumiClient(env);
  const result = await getOrSetJson(
    env,
    cacheKey(["episodes", episodeId]),
    { ttlSeconds: 6 * 60 * 60, force },
    () => client.getEpisode(episodeId),
  );
  return json({ data: result.value, cache: result.cache });
}

async function getEpisodeComments(
  episodeId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const result = await getOrSetJson(
    env,
    cacheKey(["episodes", episodeId, "comments"]),
    { ttlSeconds: 30 * 60, force },
    () => fetchEpisodeComments(env, episodeId),
  );
  return json({
    data: result.value,
    source: {
      provider: "bangumi-web",
      available: result.value.length > 0,
      note: "Bangumi official v0 API does not expose episode comments; this endpoint parses public HTML best-effort.",
    },
    cache: result.cache,
  });
}

async function getSchedule(url: URL, env: Env): Promise<Response> {
  const result = await getScheduleCached(url, env);
  return json({ ...result.value, cache: result.cache });
}

async function getTodaySchedule(url: URL, env: Env): Promise<Response> {
  const schedule = await getScheduleCached(url, env);
  const today = currentShanghaiDate();
  return json({
    generatedAt: schedule.value.generatedAt,
    date: today,
    items: schedule.value.byDate[today] ?? [],
    cache: schedule.cache,
  });
}

async function getSeason(
  url: URL,
  env: Env,
  mode: "current" | "trending",
): Promise<Response> {
  const season = parseSeason(url.searchParams.get("season"));
  const range = seasonDateRange(season);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 100);
  const input: SearchInput = {
    q: url.searchParams.get("q") ?? "",
    limit,
    offset: clampInt(url.searchParams.get("offset"), 0, 0, 5000),
    sort:
      mode === "trending"
        ? "heat"
        : (normalizeSort(url.searchParams.get("sort")) ?? "rank"),
    tags: readListParam(url, "tag"),
    metaTags: readListParam(url, "metaTag"),
    airDates: readListParam(url, "airDate").concat([
      `>=${range.start}`,
      `<=${range.end}`,
    ]),
    ratings: readListParam(url, "rating"),
    ranks: readListParam(url, "rank"),
    includeNsfw: boolParam(url.searchParams.get("includeNsfw")),
  };

  const client = new BangumiClient(env);
  const force = boolParam(url.searchParams.get("force"));
  const key = cacheKey([
    mode,
    season.code,
    input.q,
    input.sort,
    input.limit,
    input.offset,
    input.tags.join(","),
    input.metaTags.join(","),
    input.airDates.join(","),
    input.ratings.join(","),
    input.ranks.join(","),
    input.includeNsfw,
  ]);
  const result = await getOrSetJson(
    env,
    key,
    { ttlSeconds: 12 * 60 * 60, force },
    () => client.searchSubjects(input),
  );
  return json({
    season,
    range,
    ...result.value,
    cache: result.cache,
  });
}

async function refreshMaterializedCaches(env: Env): Promise<void> {
  const origin = new URL("https://melon-api.local?force=1");
  const seasonUrl = new URL("https://melon-api.local?force=1");
  await Promise.all([
    getScheduleCached(origin, env, true),
    getSeason(seasonUrl, env, "current"),
    getSeason(seasonUrl, env, "trending"),
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
): Promise<Awaited<ReturnType<typeof getOrSetJson<ScheduleResponse>>>> {
  const days = clampInt(url.searchParams.get("days"), 7, 0, 31);
  const date = url.searchParams.get("date") ?? currentShanghaiDate();
  const requireBroadcast = boolParam(url.searchParams.get("requireBroadcast"));
  const includeNsfw = boolParam(url.searchParams.get("includeNsfw"));
  const includeUnknownNsfw = !["0", "false", "no"].includes(
    url.searchParams.get("includeUnknownNsfw") ?? "",
  );
  const force = forceOverride || boolParam(url.searchParams.get("force"));
  const keyParts =
    includeNsfw || !includeUnknownNsfw
      ? [
          "schedule",
          date,
          days,
          requireBroadcast,
          "nsfw",
          includeNsfw,
          includeUnknownNsfw,
        ]
      : ["schedule", date, days, requireBroadcast];
  return getOrSetJson(
    env,
    cacheKey(keyParts),
    { ttlSeconds: 24 * 60 * 60, force },
    () =>
      buildScheduleResponse(env, {
        days,
        date,
        requireBroadcast,
        includeNsfw,
        includeUnknownNsfw,
      }),
  );
}

async function getScheduleValue(url: URL, env: Env): Promise<ScheduleResponse> {
  return (await getScheduleCached(url, env)).value;
}

function searchInputFromUrl(url: URL): SearchInput {
  return {
    q: url.searchParams.get("q") ?? "",
    limit: clampInt(url.searchParams.get("limit"), 20, 1, 100),
    offset: clampInt(url.searchParams.get("offset"), 0, 0, 5000),
    sort: normalizeSort(url.searchParams.get("sort")) ?? "match",
    tags: readListParam(url, "tag"),
    metaTags: readListParam(url, "metaTag"),
    airDates: readListParam(url, "airDate"),
    ratings: readListParam(url, "rating"),
    ranks: readListParam(url, "rank"),
    includeNsfw: boolParam(url.searchParams.get("includeNsfw")),
  };
}

function normalizeSort(value: string | null): SearchInput["sort"] | undefined {
  if (
    value === "match" ||
    value === "heat" ||
    value === "rank" ||
    value === "score"
  )
    return value;
  return undefined;
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function note(part: string, error: unknown): string {
  return `${part}: ${error instanceof Error ? error.message : "unavailable"}`;
}
