import { BangumiClient, type SearchInput } from "./bangumi";
import { cacheKey, cacheHeaders, cacheEtag, cleanupExpiredCacheObjects, getOrSetJson, matchesEtag, queryCacheKey, readJson, waitForCacheLoad, writeJson, type CacheResult } from "./cache";
import {
  fetchEpisodeComments,
  fetchSubjectComments,
  fetchSubjectTopics,
} from "./html";
import { docsHtml, openApiSpec } from "./openapi";
import { sourceRules } from "./sources";
import { loadSeasonCatalogue } from "./seasons";
import {
  buildScheduleResponse,
  fallbackScheduleFromAirDate,
  loadSubjectSchedule,
  loadSubjectAliases,
  loadBangumiData,
} from "./schedule";
import { HttpError, type Env, type ScheduleResponse, type SubjectDetail } from "./types";
import {
  applyCorsHeaders,
  boolParam,
  clampInt,
  currentShanghaiDate,
  dateParam,
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
  const id = /^v1\/(?:subjects|episodes)\/(\d+)(?:\/|$)/.exec(path)?.[1];
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
    return searchSubjects(url, env, ctx);
  if (request.method === "GET" && /^v1\/subjects\/\d+$/.test(path)) {
    return getSubject(Number(path.split("/")[2]), url, env, ctx, request);
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
    return getSubjectComments(Number(path.split("/")[2]), env);
  }
  if (request.method === "GET" && /^v1\/subjects\/\d+\/topics$/.test(path)) {
    return getSubjectTopics(Number(path.split("/")[2]), env);
  }
  if (request.method === "GET" && /^v1\/episodes\/\d+$/.test(path)) {
    return getEpisode(Number(path.split("/")[2]), url, env);
  }
  if (request.method === "GET" && /^v1\/episodes\/\d+\/comments$/.test(path)) {
    return getEpisodeComments(Number(path.split("/")[2]), env);
  }
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

async function searchSubjects(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const client = new BangumiClient(env);
  const input = searchInputFromUrl(url);
  const force = boolParam(url.searchParams.get("force"));
  const key = queryCacheKey("search-v2", input);
  const result = await getOrSetJson(
    env,
    key,
    { ttlSeconds: 30 * 60, force, staleWhileRevalidateSeconds: 24 * 60 * 60 },
    () => client.searchSubjects(input),
    (task) => ctx.waitUntil(task),
  );
  return cachedJson({ ...result.value, cache: result.cache }, result.cache);
}

async function getSubject(
  subjectId: number, url: URL, env: Env, ctx: ExecutionContext, request: Request,
): Promise<Response> {
  const full = boolParam(url.searchParams.get("full"), true);
  const view = url.searchParams.get("view") ?? "full";
  if (!["basic", "playback", "full"].includes(view)) throw new HttpError(400, "INVALID_PARAMETER", "Unknown subject view.");
  const includeHtml = full && view === "full" && boolParam(url.searchParams.get("includeHtml"), !url.searchParams.has("view"));
  const date = dateParam(url.searchParams.get("date"));
  const force = boolParam(url.searchParams.get("force"));
  const version = clampInt(url.searchParams.get("streamVersion"), 1, 1, 2);
  const key = cacheKey(["subjects", subjectId, full ? `view-${view}-v5` : "brief", full && view === "full" ? date : ""]);
  const streaming = full && request.headers.get("accept")?.split(",").some(
    (entry) => entry.trim().split(";")[0] === "application/x-ndjson",
  );
  if (!force && !includeHtml && request.headers.has("if-none-match")) {
    const cached = await readJson<SubjectDetail>(env, key).catch(() => null);
    if (cached && matchesEtag(request, cacheEtag(key, cached.cachedAt, cached.revision))) {
      const headers = new Headers({ ...cacheHeaders({ key, hit: true, cachedAt: cached.cachedAt,
        expiresAt: cached.expiresAt, etag: cacheEtag(key, cached.cachedAt, cached.revision) }), vary: "Accept", "cache-control": "no-cache" });
      applyCorsHeaders(headers);
      return new Response(null, { status: 304, headers });
    }
  }
  const load = async (progress?: (event: SubjectDetailProgress) => void) => {
    const result = await getOrSetJson(env, key, {
      ttlSeconds: full ? 6 * 60 * 60 : 60 * 60, force, staleWhileRevalidateSeconds: 24 * 60 * 60,
    }, async (foreground) => {
      const client = new BangumiClient(env, AbortSignal.timeout(18_000));
      if (!full) return client.getSubject(subjectId);
      return loadSubjectDetail(subjectId, date, env, ctx, force, client, view as SubjectView, version,
        foreground ? progress : undefined);
    }, includeHtml ? undefined : (task) => ctx.waitUntil(task));
    const data = includeHtml ? await withLiveSubjectHtmlParts(result.value as SubjectDetail, subjectId, env) : result.value;
    return { data, cache: result.cache };
  };
  if (streaming) {
    return subjectDetailStream(request, async (send) => {
      let progressed = false;
      const result = await load((event) => { progressed = true; send(event); });
      send({ type: "complete", ...(version === 2 && progressed && !includeHtml ? { cache: result.cache } : result) });
    });
  }
  const result = await load();
  return includeHtml ? json(result, { headers: { "cache-control": "no-store", vary: "Accept" } }) :
    cachedJson(result, result.cache, { vary: "Accept" });
}

type SubjectView = "basic" | "playback" | "full";

type SubjectDetailPart = "episodes" | "characters" | "staff" | "relatedSubjects" | "aliases" | "schedule";
type SubjectDetailParts = Pick<SubjectDetail, SubjectDetailPart>;
type SubjectDetailProgress =
  | { type: "snapshot"; data: SubjectDetail; pending: SubjectDetailPart[] }
  | { type: "patch"; data: { [K in keyof SubjectDetail]?: SubjectDetail[K] | null }; pending: SubjectDetailPart[]; append?: string[] };

async function loadSubjectDetail(
  subjectId: number,
  date: string,
  env: Env,
  ctx: ExecutionContext,
  force: boolean,
  client: BangumiClient,
  view: SubjectView,
  version: number,
  progress?: (event: SubjectDetailProgress) => void,
): Promise<SubjectDetail> {
  const wanted: SubjectDetailPart[] = view === "basic" ? [] : view === "playback" ? ["episodes", "aliases"] :
    ["episodes", "characters", "staff", "relatedSubjects", "aliases", "schedule"];
  const pending = new Set<SubjectDetailPart>(wanted);
  const parts: SubjectDetailParts = {
    episodes: [], characters: [], staff: [], relatedSubjects: [], aliases: [], schedule: undefined,
  };
  let snapshotSent = false;
  const queuedProgress: SubjectDetailProgress[] = [];
  const sendProgress = (event: SubjectDetailProgress) => {
    if (!progress) return;
    if (snapshotSent) progress?.(event);
    else queuedProgress.push(event);
  };
  const assemble = (subject: Awaited<ReturnType<BangumiClient["getSubjectRaw"]>>) => {
    const detail = client.mapSubjectDetail(subject, {
      ...parts, comments: [], topics: [], notes: [],
    });
    detail.aliases = parts.aliases;
    detail.schedule = parts.schedule ?? fallbackScheduleFromAirDate(detail.airDate);
    return detail;
  };
  const ready = <K extends SubjectDetailPart>(part: K, value: SubjectDetailParts[K], emit = true) => {
    parts[part] = value;
    pending.delete(part);
    sendProgress({ type: "patch", data: emit ? { [part]: value ?? null } : {}, pending: [...pending] });
  };
  const background = (task: Promise<unknown>) => ctx.waitUntil(task);
  const part = <T>(name: string, ttl: number, loader: () => Promise<T>) => getOrSetJson(env,
    cacheKey(["subjects", subjectId, name]), { ttlSeconds: ttl, force }, loader, background).then((result) => result.value);
  const loaders: Record<SubjectDetailPart, () => Promise<void>> = {
    episodes: async () => {
      const episodes = await client.getEpisodes(subjectId, version === 2 ? (page) => {
        parts.episodes.push(...page);
        sendProgress({ type: "patch", data: { episodes: page }, append: ["episodes"], pending: [...pending] });
      } : undefined, force, background);
      ready("episodes", episodes, version !== 2);
    },
    characters: async () => ready("characters", await part("characters", 86400, () => client.getCharacters(subjectId))),
    staff: async () => ready("staff", await part("staff", 86400, () => client.getPersons(subjectId))),
    relatedSubjects: async () => ready("relatedSubjects", await part("related", 86400, () => client.getRelatedSubjects(subjectId))),
    aliases: async () => ready("aliases", await loadSubjectAliases(env, subjectId, force, background)),
    schedule: async () => ready("schedule", await loadSubjectSchedule(env, subjectId, date, force, background)),
  };
  const [subject] = await Promise.all([
    part("base-v1", 3600, () => client.getSubjectRaw(subjectId)).then((subject) => {
      const snapshot = client.mapSubjectDetail(subject, {
        episodes: [], characters: [], staff: [], relatedSubjects: [], comments: [], topics: [], notes: [],
      });
      snapshot.aliases = [];
      snapshot.schedule = fallbackScheduleFromAirDate(snapshot.airDate);
      progress?.({ type: "snapshot", data: snapshot, pending: wanted });
      snapshotSent = true;
      for (const event of queuedProgress) progress?.(event);
      queuedProgress.length = 0;
      return subject;
    }),
    ...wanted.map((name) => loaders[name]()),
  ]);
  const detail = assemble(subject);
  if (version === 2) progress?.({ type: "patch", data: { source: detail.source, schedule: detail.schedule ?? null }, pending: [] });
  return detail;
}

function subjectDetailStream(
  request: Request,
  produce: (send: (event: SubjectDetailProgress | { type: "complete"; data?: unknown; cache: unknown }) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      void produce(send).then(() => {
        if (open) {
          open = false;
          controller.close();
        }
      }, (error: unknown) => {
        console.error(error);
        send({ type: "error", error: { message: error instanceof Error ? error.message : "Unknown error",
          ...(error instanceof HttpError ? { status: error.status, code: error.code, retryAfter: error.retryAfter } : {}) } });
        if (open) {
          open = false;
          controller.close();
        }
      });
    },
    cancel() {
      open = false;
    },
  });
  const headers = new Headers({
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "vary": "Accept, Accept-Encoding",
  });
  const clientEncoding = (request as Request & { cf?: { clientAcceptEncoding?: string | null } }).cf?.clientAcceptEncoding
    ?? request.headers.get("accept-encoding");
  const acceptsGzip = clientEncoding?.split(",").some((entry) => {
    const [encoding, ...parameters] = entry.trim().split(";");
    const quality = parameters.find((value) => value.trim().startsWith("q="));
    return encoding === "gzip" && (quality === undefined || Number(quality.trim().slice(2)) > 0);
  });
  if (acceptsGzip) headers.set("content-encoding", "gzip");
  applyCorsHeaders(headers);
  return new Response(body, { headers });
}

async function withLiveSubjectHtmlParts(
  detail: SubjectDetail,
  subjectId: number,
  env: Env,
): Promise<SubjectDetail> {
  const { comments, topics, notes } = await fetchLiveSubjectHtmlParts(
    env,
    subjectId,
  );
  const stableNotes = detail.source.notes.filter(
    (entry) =>
      !entry.startsWith("commentsHtml:") && !entry.startsWith("topicsHtml:"),
  );
  return {
    ...detail,
    comments,
    topics,
    source: {
      ...detail.source,
      apiCoverage: {
        ...detail.source.apiCoverage,
        comments: comments.length > 0,
        topics: topics.length > 0,
      },
      notes: [...stableNotes, ...notes],
    },
  };
}

async function fetchLiveSubjectHtmlParts(
  env: Env,
  subjectId: number,
): Promise<{
  comments: SubjectDetail["comments"];
  topics: SubjectDetail["topics"];
  notes: string[];
}> {
  const notes: string[] = [];
  const [comments, topics] = await Promise.all([
    fetchSubjectComments(env, subjectId).catch((error) => {
      notes.push(note("commentsHtml", error));
      return [];
    }),
    fetchSubjectTopics(env, subjectId).catch((error) => {
      notes.push(note("topicsHtml", error));
      return [];
    }),
  ]);
  return { comments, topics, notes };
}

async function getSubjectEpisodes(
  subjectId: number,
  url: URL,
  env: Env,
): Promise<Response> {
  const force = boolParam(url.searchParams.get("force"));
  const client = new BangumiClient(env);
  const paged = url.searchParams.has("limit") || url.searchParams.has("offset");
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (paged) {
    const result = await getOrSetJson(env, cacheKey(["subjects", subjectId, "episodes-response-v3", limit, offset]),
      { ttlSeconds: 21600, force }, () => client.getEpisodesPage(subjectId, limit, offset, force));
    return cachedJson({ ...result.value, cache: result.cache }, result.cache);
  }
  const result = await getOrSetJson(
    env,
    cacheKey(["subjects", subjectId, "episodes-v3"]),
    { ttlSeconds: 6 * 60 * 60, force },
    () => client.getEpisodes(subjectId, undefined, force),
  );
  return cachedJson({ data: result.value, cache: result.cache }, result.cache);
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
  return cachedJson({ data: result.value, cache: result.cache }, result.cache);
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
  return cachedJson({ data: result.value, cache: result.cache }, result.cache);
}

async function getSubjectComments(
  subjectId: number,
  env: Env,
): Promise<Response> {
  const comments = await fetchSubjectComments(env, subjectId);
  return json(
    {
      data: comments,
      source: {
        provider: "bangumi-web",
        available: comments.length > 0,
        note: "Bangumi official v0 API does not expose subject comments; this endpoint parses public HTML best-effort.",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function getSubjectTopics(
  subjectId: number,
  env: Env,
): Promise<Response> {
  const topics = await fetchSubjectTopics(env, subjectId);
  return json(
    {
      data: topics,
      source: {
        provider: "bangumi-web",
        available: topics.length > 0,
        note: "Bangumi official v0 API does not expose subject board topics; this endpoint parses public HTML best-effort.",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
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
  return cachedJson({ data: result.value, cache: result.cache }, result.cache);
}

async function getEpisodeComments(
  episodeId: number,
  env: Env,
): Promise<Response> {
  const comments = await fetchEpisodeComments(env, episodeId);
  return json(
    {
      data: comments,
      source: {
        provider: "bangumi-web",
        available: comments.length > 0,
        note: "Bangumi official v0 API does not expose episode comments; this endpoint parses public HTML best-effort.",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
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
  ctx?: ExecutionContext,
): Promise<Response> {
  const season = parseSeason(url.searchParams.get("season"));
  const range = seasonDateRange(season);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 100);
  const requestedSort = normalizeSort(url.searchParams.get("sort"));
  const input: SearchInput = {
    q: (url.searchParams.get("q") ?? "").trim(),
    limit,
    offset: clampInt(url.searchParams.get("offset"), 0, 0, 5000),
    sort:
      mode === "trending"
        ? "heat"
        : (requestedSort ?? "rank"),
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

  const force = boolParam(url.searchParams.get("force"));
  if (!input.q && !input.tags.length && !input.metaTags.length && !input.ratings.length &&
      !input.ranks.length && input.airDates.length === 2 && (input.sort === "heat" || input.sort === "rank")) {
    const result = await loadSeasonCatalogue(env, season, input.sort, input.includeNsfw, force,
      ctx ? (task) => ctx.waitUntil(task) : undefined);
    const cache = { ...result.cache, etag: `${result.cache.etag.slice(0, -1)}-${mode}-${input.limit}-${input.offset}"` };
    const total = result.value.total;
    return cachedJson({
      season, range, total, limit: input.limit, offset: input.offset,
      hasMore: input.offset + input.limit < total && input.offset + input.limit <= 5000,
      data: result.value.data.slice(input.offset, input.offset + input.limit), cache,
    }, cache);
  }
  const client = new BangumiClient(env);
  const key = queryCacheKey(`${mode}-v2`, { season: season.code, ...input });
  const result = await getOrSetJson(
    env,
    key,
    {
      ttlSeconds: 12 * 60 * 60,
      force,
      staleWhileRevalidateSeconds: 24 * 60 * 60,
    },
    () => client.searchSubjects(input),
    ctx ? (task) => ctx.waitUntil(task) : undefined,
  );
  return cachedJson({
    season,
    range,
    ...result.value,
    cache: result.cache,
  }, result.cache);
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

function searchInputFromUrl(url: URL): SearchInput {
  return {
    q: (url.searchParams.get("q") ?? "").trim(),
    limit: clampInt(url.searchParams.get("limit"), 10, 1, 100),
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
  if (value != null) throw new HttpError(400, "INVALID_PARAMETER", "Unknown sort order.");
  return undefined;
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function note(part: string, error: unknown): string {
  return `${part}: ${error instanceof Error ? error.message : "unavailable"}`;
}

function cachedJson(data: unknown, cache: CacheResult<unknown>["cache"], headers: Record<string, string> = {}): Response {
  return json(data, { headers: { ...cacheHeaders(cache), ...headers } });
}
