import { BangumiClient, subjectIdFromSites } from "./bangumi";
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
  seasonDateRange,
  shanghaiDateString,
  weekdayInShanghai,
} from "./utils";

const MS_DAY = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

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
    requireBroadcast?: boolean;
    includeNsfw?: boolean;
    includeUnknownNsfw?: boolean;
  },
): Promise<ScheduleResponse> {
  const centerDate = input.date ?? currentShanghaiDate();
  const windowStart = shanghaiDayStartUtc(
    addDaysToDateString(centerDate, -input.days),
  );
  const windowEnd = shanghaiDayStartUtc(
    addDaysToDateString(centerDate, input.days + 1),
  );
  const data = await loadBangumiData(env);
  const subjectIds = collectScheduleSubjectIds(
    data.items ?? [],
    windowStart,
    windowEnd,
  );
  const enrichment = await loadScheduleEnrichment(
    env,
    windowStart,
    windowEnd,
    subjectIds,
  ).catch((error) => {
    console.warn("schedule enrichment unavailable", error);
    return new Map<number, SubjectListItem>();
  });
  const items = buildSchedule(data.items ?? [], windowStart, windowEnd, {
    requireBroadcast: input.requireBroadcast ?? false,
    includeNsfw: input.includeNsfw ?? false,
    includeUnknownNsfw: input.includeUnknownNsfw ?? true,
    enrichment,
  });
  const byDate: Record<string, ScheduleOccurrence[]> = {};
  for (const item of items) {
    const date = item.airingAtShanghai.slice(0, 10);
    byDate[date] ??= [];
    byDate[date].push(item);
  }

  return {
    generatedAt: new Date().toISOString(),
    centerDate,
    days: input.days,
    window: {
      start: formatInShanghai(windowStart),
      endExclusive: formatInShanghai(windowEnd),
    },
    items,
    byDate,
  };
}

export async function loadBangumiData(env: Env): Promise<BangumiData> {
  const configured =
    env.BANGUMI_DATA_SOURCE ??
    "https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json";
  const sources = unique([
    configured,
    "https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json",
    "https://unpkg.com/bangumi-data@0.3/dist/data.json",
  ]);
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const response = await fetch(source, {
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
  subjectIds: number[],
): Promise<Map<number, SubjectListItem>> {
  const client = new BangumiClient(env);
  const bySubjectId = new Map<number, SubjectListItem>();

  const calendarSubjects = await client.getCalendarSubjects().catch((error) => {
    console.warn("Bangumi calendar enrichment unavailable", error);
    return [];
  });
  for (const subject of calendarSubjects)
    bySubjectId.set(subject.subjectId, subject);

  const seasons = seasonsInWindow(start, end);
  await Promise.all(
    seasons.map(async (season) => {
      const range = seasonDateRange(season);
      const page = await client
        .searchSubjects({
          q: "",
          limit: 100,
          offset: 0,
          sort: "rank",
          tags: [],
          metaTags: [],
          airDates: [`>=${range.start}`, `<=${range.end}`],
          ratings: [],
          ranks: [],
          includeNsfw: true,
        })
        .catch((error) => {
          console.warn(
            `Bangumi season enrichment unavailable for ${season.code}`,
            error,
          );
          return null;
        });
      for (const subject of page?.data ?? [])
        bySubjectId.set(subject.subjectId, subject);
    }),
  );

  const preciseSubjects = await client
    .getSubjectsByIds(subjectIds)
    .catch((error) => {
      console.warn("Bangumi precise schedule enrichment unavailable", error);
      return [];
    });
  for (const subject of preciseSubjects)
    bySubjectId.set(subject.subjectId, subject);

  return bySubjectId;
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
