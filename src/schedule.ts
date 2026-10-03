import { cacheKey, getOrSetJson } from "./cache";
import { BangumiClient, subjectIdFromSites } from "./bangumi";
import { loadSeasonCatalogue } from "./seasons";
import type {
  Env,
  ScheduleOccurrence,
  ScheduleResponse,
  SubjectListItem,
  SubjectSchedule,
} from "./types";
import {
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
  background?: (task: Promise<unknown>) => void,
  onRepair?: (value: ScheduleResponse) => Promise<void>,
): Promise<ScheduleResponse> {
  const centerDate = input.startDate ?? input.date ?? currentShanghaiDate();
  const windowStart = shanghaiDayStartUtc(
    input.startDate ?? addDaysToDateString(centerDate, -input.days),
  );
  const windowEnd = shanghaiDayStartUtc(
    input.startDate ? addDaysToDateString(input.startDate, input.dayCount ?? 7) : addDaysToDateString(centerDate, input.days + 1),
  );
  const dataLoading = loadBangumiData(env, input.force, background);
  const enrichmentLoading = loadScheduleEnrichment(
    env,
    windowStart,
    windowEnd,
    dataLoading.then((data) => collectScheduleSubjectIds(
      data.items ?? [],
      windowStart,
      windowEnd,
    )),
    input.force,
    background,
    onRepair ? async (enrichment) => onRepair(assemble(await dataLoading, enrichment)) : undefined,
  ).catch((error) => {
    console.warn("schedule enrichment unavailable", error);
    return new Map<number, SubjectListItem>();
  });
  const [data, enrichment] = await Promise.all([dataLoading, enrichmentLoading]);
  return assemble(data, enrichment);
  function assemble(data: BangumiData, enrichment: Map<number, SubjectListItem>): ScheduleResponse {
    const items = buildSchedule(data.items ?? [], windowStart, windowEnd, {
      requireBroadcast: input.requireBroadcast ?? false,
      includeNsfw: input.includeNsfw ?? false,
      includeUnknownNsfw: input.includeUnknownNsfw ?? true,
      enrichment,
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
    };
  }
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

async function loadScheduleEnrichment(
  env: Env,
  start: Date,
  end: Date,
  requestedSubjectIds: Promise<number[]>,
  force = false,
  background?: (task: Promise<unknown>) => void,
  onRepair?: (enrichment: Map<number, SubjectListItem>) => Promise<void>,
): Promise<Map<number, SubjectListItem>> {
  const client = new BangumiClient(env, AbortSignal.timeout(15_000));
  const bySubjectId = new Map<number, SubjectListItem>();
  const seasons = seasonsInWindow(start, end);
  const [subjectIds, calendarSubjects, ...seasonPages] = await Promise.all([
    requestedSubjectIds,
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
  for (const subject of [...calendarSubjects, ...seasonPages.flat()]) {
    bySubjectId.set(
      subject.subjectId,
      mergeScheduleSubject(bySubjectId.get(subject.subjectId), subject),
    );
  }
  const missing = subjectIds.filter((id) => {
    const subject = bySubjectId.get(id);
    return !subject?.coverUrl || !subject.episodeTotal || subject.nsfw == null;
  });
  const repair = async (repairClient: BangumiClient) => {
    for (const subject of await repairClient.getSubjectsByIds(missing, force, background)) {
      const previous = bySubjectId.get(subject.subjectId);
      bySubjectId.set(subject.subjectId, mergeScheduleSubject(previous, subject));
    }
  };
  if (missing.length && background && onRepair) {
    background(repair(new BangumiClient(env, AbortSignal.timeout(25_000)))
      .then(() => onRepair(bySubjectId))
      .catch((error) => console.warn("Schedule artwork repair failed", error)));
  } else {
    await repair(client);
  }
  return bySubjectId;
}

function mergeScheduleSubject(
  previous: SubjectListItem | undefined,
  subject: SubjectListItem,
): SubjectListItem {
  return {
    ...previous,
    ...subject,
    coverUrl: subject.coverUrl || previous?.coverUrl,
    episodeTotal: subject.episodeTotal || previous?.episodeTotal,
    nsfw: subject.nsfw ?? previous?.nsfw,
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

export async function loadSubjectSchedule(
  env: Env,
  subjectId: number,
  date = currentShanghaiDate(),
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<SubjectSchedule | undefined> {
  const data = await loadBangumiData(env, force, background);
  const matching = subjectItems(data, subjectId);
  const occurrences = buildSchedule(
    matching,
    shanghaiDayStartUtc(addDaysToDateString(date, -7)),
    shanghaiDayStartUtc(addDaysToDateString(date, 8)),
    {
      requireBroadcast: false,
      includeNsfw: true,
      includeUnknownNsfw: true,
      enrichment: new Map(),
    },
  );
  return scheduleForSubject(occurrences, subjectId);
}

export function scheduleForSubject(
  items: ScheduleOccurrence[],
  subjectId: number,
): SubjectSchedule | undefined {
  const occurrences = items.filter((item) => item.subjectId === subjectId);
  const first = occurrences[0];
  if (!first) return undefined;
  const next = occurrences.find(
    (item) => Date.parse(item.airingAt) >= Date.now(),
  );
  return {
    firstAiringAt: first.airingAt,
    firstAiringAtShanghai: first.airingAtShanghai,
    weekday: first.weekday,
    recurrence: first.source.broadcast?.endsWith("/P1D")
      ? "P1D"
      : first.source.broadcast?.endsWith("/P1M")
        ? "P1M"
        : first.source.broadcast?.endsWith("/P0D")
          ? "P0D"
          : "P7D",
    nextAiringAt: next?.airingAt,
    nextAiringAtShanghai: next?.airingAtShanghai,
    source: "bangumi-data",
  };
}

export function fallbackScheduleFromAirDate(
  airDate?: string,
): SubjectSchedule | undefined {
  if (!airDate) return undefined;
  const season = seasonFromDate(airDate);
  const start = new Date(`${airDate}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return undefined;
  return {
    firstAiringAt: start.toISOString(),
    firstAiringAtShanghai: formatInShanghai(start),
    weekday: weekdayInShanghai(start),
    recurrence: "P7D",
    source: season ? "bangumi-date" : "unknown",
  };
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

    for (const occurrence of occurrences) {
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
