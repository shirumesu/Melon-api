import { cacheKey, getOrSetJson } from "./cache";
import { BangumiClient, subjectIdFromSites } from "./bangumi";
import { loadSeasonCatalogue } from "./seasons";
import {
  briefSummary,
  FetchBudget,
  loadScheduleSubjects,
  pending,
  weekOf,
  weeklyHeat,
  type ScheduleSubject,
  type WeeklyHeat,
} from "./schedule_subjects";
import type {
  Env,
  ScheduleOccurrence,
  ScheduleResponse,
  SubjectListItem,
} from "./types";
import {
  compact,
  currentShanghaiDate,
  formatInShanghai,
  seasonFromDate,
  shanghaiDateString,
  weekdayInShanghai,
} from "./utils";

const MS_DAY = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const subjectIndexes = new WeakMap<BangumiData, Map<number, BangumiDataItem[]>>();

function subjectItems(data: BangumiData, subjectId: number): BangumiDataItem[] {
  let index = subjectIndexes.get(data);
  if (!index) {
    index = new Map();
    for (const item of data.items ?? []) {
      const id = subjectIdFromSites(item.sites ?? []);
      if (id == null) continue;
      const entries = index.get(id) ?? [];
      entries.push(item);
      index.set(id, entries);
    }
    subjectIndexes.set(data, index);
  }
  return index.get(subjectId) ?? [];
}

type BangumiData = {
  items?: BangumiDataItem[];
};

type BangumiDataItem = {
  id?: string | number;
  type?: string;
  title: string;
  titleTranslate?: Record<string, string[]>;
  begin?: string;
  end?: string;
  broadcast?: string;
  sites?: Array<{
    site: string;
    id?: string | number;
    url?: string | null;
  }>;
};

export async function buildScheduleResponse(
  env: Env,
  input: {
    days: number;
    date?: string;
    startDate?: string;
    dayCount?: number;
    force?: boolean;
    requireBroadcast?: boolean;
    includeNsfw?: boolean;
    includeUnknownNsfw?: boolean;
  },
  budget: FetchBudget,
  background?: (task: Promise<unknown>) => void,
): Promise<ScheduleResponse> {
  const centerDate = input.startDate ?? input.date ?? currentShanghaiDate();
  const windowStart = shanghaiDayStartUtc(
    input.startDate ?? addDaysToDateString(centerDate, -input.days),
  );
  const windowEnd = shanghaiDayStartUtc(
    input.startDate ? addDaysToDateString(input.startDate, input.dayCount ?? 7) : addDaysToDateString(centerDate, input.days + 1),
  );
  const data = await loadBangumiData(env, input.force, background);
  const subjectIds = collectScheduleSubjectIds(data.items ?? [], windowStart, windowEnd);
  const { enrichment, store } = await loadScheduleEnrichment(
    env, windowStart, windowEnd, subjectIds, budget, input.force, background,
  );
  const heat = await weeklyHeat(env, weekOf(shanghaiDateString(windowStart)), store);
  const items = buildSchedule(data.items ?? [], windowStart, windowEnd, {
    requireBroadcast: input.requireBroadcast ?? false,
    includeNsfw: input.includeNsfw ?? false,
    includeUnknownNsfw: input.includeUnknownNsfw ?? true,
    enrichment,
    store,
    heat,
  });
  return {
    generatedAt: new Date().toISOString(),
    centerDate,
    days: input.days,
    ...(input.startDate ? { startDate: input.startDate, dayCount: input.dayCount ?? 7 } : {}),
    window: {
      start: formatInShanghai(windowStart),
      endExclusive: formatInShanghai(windowEnd),
    },
    items,
    incomplete: subjectIds.filter((id) => pending(store.get(id))).length,
    ...(heat ? { heat: { week: heat.week, since: heat.since } } : {}),
  };
}

export async function loadBangumiData(
  env: Env,
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<BangumiData> {
  const configured =
    env.BANGUMI_DATA_SOURCE ??
    "https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json";
  return (await getOrSetJson(
    env,
    cacheKey(["source", "bangumi-data", configured]),
    { ttlSeconds: 6 * 60 * 60, force },
    () => fetchBangumiData(env, configured),
    background,
  )).value;
}

async function fetchBangumiData(env: Env, configured: string): Promise<BangumiData> {
  const sources = unique([
    configured,
    "https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json",
    "https://unpkg.com/bangumi-data@0.3/dist/data.json",
  ]);
  const errors: string[] = [];
  const signal = AbortSignal.timeout(10_000);

  for (const source of sources) {
    try {
      const response = await fetch(source, {
        signal,
        headers: {
          "user-agent": env.BANGUMI_USER_AGENT ?? "melon-api/0.1",
        },
      });
      if (!response.ok) {
        errors.push(`${source}: ${response.status}`);
        continue;
      }
      return (await response.json()) as BangumiData;
    } catch (error) {
      errors.push(
        `${source}: ${error instanceof Error ? error.message : "network error"}`,
      );
    }
  }

  throw new Error(
    `Failed to fetch bangumi-data from all sources: ${errors.join("; ")}`,
  );
}

/**
 * What the window's subjects show: the Bangumi calendar and season lists
 * first, then each subject's own details, which [budget] fetches when
 * missing or out of date.
 */
async function loadScheduleEnrichment(
  env: Env,
  start: Date,
  end: Date,
  subjectIds: number[],
  budget: FetchBudget,
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<{ enrichment: Map<number, SubjectListItem>; store: Map<number, ScheduleSubject> }> {
  const client = new BangumiClient(env, AbortSignal.timeout(15_000));
  const bySubjectId = new Map<number, SubjectListItem>();
  const seasons = seasonsInWindow(start, end);
  const [store, calendarSubjects, ...seasonPages] = await Promise.all([
    loadScheduleSubjects(env, subjectIds, budget),
    getOrSetJson(
      env,
      "source/calendar",
      { ttlSeconds: 60 * 60, force },
      () => client.getCalendarSubjects(),
      background,
    )
      .then((result) => result.value)
      .catch((error) => {
        console.warn("Bangumi calendar enrichment unavailable", error);
        return [];
      }),
    ...seasons.map(async (season) => {
      return loadSeasonCatalogue(env, season, "rank", true, force, background)
        .then((result) => result.value.data)
        .catch((error) => {
          console.warn(`Bangumi season enrichment unavailable for ${season.code}`, error);
          return [];
        });
    }),
  ]);
  const briefs = subjectIds.flatMap((id) => store.get(id)?.brief ?? []);
  for (const subject of [...calendarSubjects, ...seasonPages.flat(), ...briefs]) {
    bySubjectId.set(
      subject.subjectId,
      mergeScheduleSubject(bySubjectId.get(subject.subjectId), subject),
    );
  }
  return { enrichment: bySubjectId, store };
}

function mergeScheduleSubject(
  previous: SubjectListItem | undefined,
  subject: SubjectListItem,
): SubjectListItem {
  // Later sources are fuller: each value they have replaces the earlier one.
  return {
    ...previous,
    ...compact(subject) as SubjectListItem,
    coverUrl: subject.coverUrl || previous?.coverUrl,
    tags: subject.tags.length ? subject.tags : previous?.tags ?? [],
    metaTags: subject.metaTags.length ? subject.metaTags : previous?.metaTags ?? [],
  };
}

export async function loadSubjectAliases(
  env: Env,
  subjectId: number,
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<string[]> {
  const data = await loadBangumiData(env, force, background);
  const names = subjectItems(data, subjectId)
    .flatMap((item) => [item.title, ...Object.values(item.titleTranslate ?? {}).flat()]);
  return unique(names.map((name) => name.trim()).filter(Boolean));
}

function buildSchedule(
  items: BangumiDataItem[],
  start: Date,
  end: Date,
  options: {
    requireBroadcast: boolean;
    includeNsfw: boolean;
    includeUnknownNsfw: boolean;
    enrichment: Map<number, SubjectListItem>;
    store: Map<number, ScheduleSubject>;
    heat: WeeklyHeat | null;
  },
): ScheduleOccurrence[] {
  const schedule: ScheduleOccurrence[] = [];
  for (const item of items) {
    if (!["tv", "web"].includes(item.type ?? "")) continue;
    if (options.requireBroadcast && !item.broadcast) continue;
    if (!item.broadcast && !item.begin) continue;

    const occurrences = expandRule(item, start, end);
    if (!occurrences) continue;
    const names = pickNames(item);
    const sites = pickSites(item.sites ?? []);
    const subjectId = subjectIdFromSites(sites);
    const enriched = subjectId ? options.enrichment.get(subjectId) : undefined;
    const nsfwStatus =
      enriched?.nsfw === true
        ? "nsfw"
        : enriched?.nsfw === false
          ? "safe"
          : "unknown";
    if (!options.includeNsfw && enriched?.nsfw === true) continue;
    if (!options.includeUnknownNsfw && enriched?.nsfw == null) continue;
    const stored = subjectId ? options.store.get(subjectId) : undefined;
    const heat = subjectId ? options.heat?.gains.get(subjectId) : undefined;

    for (const occurrence of occurrences) {
      const episode = stored && airingEpisode(stored, occurrence, enriched?.episodeTotal);
      const resumes = stored && !episode ? breakEnd(stored, occurrence) : undefined;
      schedule.push({
        airingAt: occurrence.toISOString(),
        airingAtShanghai: formatInShanghai(occurrence),
        weekday: weekdayInShanghai(occurrence),
        subjectId,
        name: names.native,
        nameCn: enriched?.nameCn ?? names.zhHans,
        displayName: enriched?.displayName ?? names.display,
        type: item.type ?? enriched?.platform ?? "tv",
        coverUrl: enriched?.coverUrl,
        episodeTotal: enriched?.episodeTotal,
        summary: briefSummary(enriched?.summary),
        airDate: enriched?.airDate,
        platform: enriched?.platform,
        score: enriched?.score,
        rank: enriched?.rank,
        ratingCount: enriched?.ratingCount,
        collectionStats: enriched?.collectionStats,
        ...(episode ? { episode } : {}),
        ...(resumes ? { breakUntil: resumes } : {}),
        ...(heat ? { collectionGain: heat.gain, previousCollectionGain: heat.previous } : {}),
        tags: enriched?.tags ?? [],
        metaTags: enriched?.metaTags ?? [],
        nsfw: enriched?.nsfw,
        nsfwStatus,
        hasSubjectId: subjectId != null,
        detailAvailable: subjectId != null,
        needsFallback: {
          cover: !enriched?.coverUrl,
          episodeTotal: !enriched?.episodeTotal,
          nsfw: enriched?.nsfw == null,
        },
        url: enriched?.url,
        sites,
        source: {
          ruleKind: item.broadcast ? "broadcast" : "begin-weekly-fallback",
          broadcast: item.broadcast,
          begin: item.begin,
          end: item.end,
        },
      });
    }
  }

  return schedule.sort(
    (a, b) =>
      Date.parse(a.airingAt) - Date.parse(b.airingAt) ||
      a.displayName.localeCompare(b.displayName, "zh-Hans-CN"),
  );
}

/**
 * The main episode dated the broadcast's day in Japan, or a day either
 * side (Bangumi dates episodes where they first air); the nearest wins.
 * It is the final one when it is the last listed and reaches the planned
 * count of at most 60, which year-round shows do not have.
 */
function airingEpisode(
  subject: ScheduleSubject,
  occurrence: Date,
  episodeTotal: number | undefined,
): ScheduleOccurrence["episode"] {
  const day = Date.parse(new Date(occurrence.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10));
  let best: { distance: number; episode: NonNullable<ScheduleSubject["episodes"]>[number] } | undefined;
  for (const episode of subject.episodes ?? []) {
    const distance = Math.abs(Date.parse(episode.airdate) - day);
    if (distance > MS_DAY) continue;
    if (!best || distance < best.distance || (distance === best.distance && episode.sort < best.episode.sort)) {
      best = { distance, episode };
    }
  }
  if (!best) return undefined;
  const number = best.episode.ep ?? best.episode.sort;
  const final = episodeTotal != null && episodeTotal <= 60 && number >= episodeTotal &&
    best.episode.sort === subject.lastSort;
  return { ...best.episode, final };
}

/**
 * The day the next episode airs, when Bangumi dates episodes before and
 * after this broadcast but none on its day: the show takes this week off.
 */
function breakEnd(subject: ScheduleSubject, occurrence: Date): string | undefined {
  const day = Date.parse(new Date(occurrence.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const dates = (subject.episodes ?? []).map((episode) => episode.airdate).sort();
  const next = dates.find((date) => Date.parse(date) > day + MS_DAY);
  return next && dates.some((date) => Date.parse(date) < day - MS_DAY) ? next : undefined;
}

function collectScheduleSubjectIds(
  items: BangumiDataItem[],
  start: Date,
  end: Date,
): number[] {
  const subjectIds = new Set<number>();
  for (const item of items) {
    if (!["tv", "web"].includes(item.type ?? "")) continue;
    if (!item.broadcast && !item.begin) continue;
    const occurrences = expandRule(item, start, end);
    if (!occurrences?.length) continue;
    const subjectId = subjectIdFromSites(pickSites(item.sites ?? []));
    if (subjectId) subjectIds.add(subjectId);
  }
  return [...subjectIds];
}

function pickNames(item: BangumiDataItem): {
  display: string;
  native: string;
  zhHans?: string;
} {
  const translations = item.titleTranslate ?? {};
  const zhHans = firstString(translations["zh-Hans"]);
  const zhHant = firstString(translations["zh-Hant"]);
  const english = firstString(translations.en);
  return {
    display: zhHans ?? zhHant ?? english ?? item.title,
    native: item.title,
    zhHans: zhHans ?? undefined,
  };
}

function firstString(values: string[] | undefined): string | null {
  return Array.isArray(values) &&
    typeof values[0] === "string" &&
    values[0].length > 0
    ? values[0]
    : null;
}

function expandRule(
  item: BangumiDataItem,
  start: Date,
  end: Date,
): Date[] | null {
  const broadcast = item.broadcast
    ? parseBroadcast(item.broadcast)
    : parseBeginFallback(item.begin);
  if (!broadcast) return null;

  const itemEnd = item.end ? new Date(item.end) : null;
  const hardEnd = itemEnd && itemEnd < end ? itemEnd : end;

  if (broadcast.period === "P0D") {
    return broadcast.start >= start && broadcast.start < hardEnd
      ? [broadcast.start]
      : [];
  }
  if (broadcast.period === "P1D" || broadcast.period === "P7D") {
    const step = broadcast.period === "P1D" ? MS_DAY : 7 * MS_DAY;
    const firstOffset = Math.max(
      0,
      Math.floor((start.getTime() - broadcast.start.getTime()) / step) - 1,
    );
    const occurrences: Date[] = [];
    for (
      let time = broadcast.start.getTime() + firstOffset * step;
      time < hardEnd.getTime();
      time += step
    ) {
      if (time >= start.getTime()) occurrences.push(new Date(time));
    }
    return occurrences;
  }
  if (broadcast.period === "P1M") {
    const occurrences: Date[] = [];
    let current = new Date(broadcast.start);
    while (current < start) current = addUtcMonths(current, 1);
    while (current < hardEnd) {
      occurrences.push(current);
      current = addUtcMonths(current, 1);
    }
    return occurrences;
  }
  return null;
}

function parseBroadcast(
  rule: string,
): { start: Date; period: "P0D" | "P1D" | "P7D" | "P1M" } | null {
  const match = /^R\/(.+)\/(P(?:0D|1D|7D|1M))$/.exec(rule);
  if (!match) return null;
  const start = new Date(match[1]!);
  if (Number.isNaN(start.getTime())) return null;
  return { start, period: match[2] as "P0D" | "P1D" | "P7D" | "P1M" };
}

function parseBeginFallback(
  begin: string | undefined,
): { start: Date; period: "P7D" } | null {
  if (!begin) return null;
  const start = new Date(begin);
  if (Number.isNaN(start.getTime())) return null;
  return { start, period: "P7D" };
}

function pickSites(
  sites: NonNullable<BangumiDataItem["sites"]>,
): ScheduleOccurrence["sites"] {
  const wanted = new Set(["bangumi", "mal", "anilist", "anidb", "kitsu"]);
  return sites
    .filter((site) => wanted.has(site.site))
    .map((site) => ({
      site: site.site,
      id: site.id ?? null,
      url: site.url ?? null,
    }));
}

function shanghaiDayStartUtc(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!) - SHANGHAI_OFFSET_MS);
}

function addDaysToDateString(dateString: string, amount: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return shanghaiDateString(
    new Date(Date.UTC(year!, month! - 1, day! + amount) - SHANGHAI_OFFSET_MS),
  );
}

function addUtcMonths(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + amount);
  return next;
}

function seasonsInWindow(
  start: Date,
  end: Date,
): NonNullable<ReturnType<typeof seasonFromDate>>[] {
  const byCode = new Map<
    string,
    NonNullable<ReturnType<typeof seasonFromDate>>
  >();
  for (let time = start.getTime(); time < end.getTime(); time += MS_DAY) {
    const season = seasonFromDate(shanghaiDateString(new Date(time)));
    if (season) byCode.set(season.code, season);
  }
  return [...byCode.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
