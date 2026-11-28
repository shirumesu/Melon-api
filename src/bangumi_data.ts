import { subjectIdFromSites } from "./bangumi";
import { cacheKey, getOrSetJson } from "./cache";
import type { Env, ScheduleOccurrence } from "./types";

const MS_DAY = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEFAULT_SOURCE = "https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json";

export type BangumiData = {
  items?: BangumiDataItem[];
};

export type BangumiDataItem = {
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

export async function loadBangumiData(
  env: Env,
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<BangumiData> {
  const configured = env.BANGUMI_DATA_SOURCE ?? DEFAULT_SOURCE;
  return (await getOrSetJson(
    env,
    cacheKey(["source", "bangumi-data", configured]),
    { ttlSeconds: 6 * 60 * 60, force },
    () => fetchBangumiData(env, configured),
    background,
  )).value;
}

async function fetchBangumiData(env: Env, configured: string): Promise<BangumiData> {
  const sources = [...new Set([configured, DEFAULT_SOURCE, "https://unpkg.com/bangumi-data@0.3/dist/data.json"])];
  const errors: string[] = [];
  const signal = AbortSignal.timeout(10_000);
  for (const source of sources) {
    try {
      const response = await fetch(source, {
        signal,
        headers: { "user-agent": env.BANGUMI_USER_AGENT ?? "melon-api/0.1" },
      });
      if (!response.ok) {
        errors.push(`${source}: ${response.status}`);
        continue;
      }
      return (await response.json()) as BangumiData;
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : "network error"}`);
    }
  }
  throw new Error(`Failed to fetch bangumi-data from all sources: ${errors.join("; ")}`);
}

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

export async function loadSubjectAliases(
  env: Env,
  subjectId: number,
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<string[]> {
  const data = await loadBangumiData(env, force, background);
  const names = subjectItems(data, subjectId)
    .flatMap((item) => [item.title, ...Object.values(item.titleTranslate ?? {}).flat()]);
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/** Whether [item] is a TV or web series the schedule lists. */
export function scheduled(item: BangumiDataItem, requireBroadcast = false): boolean {
  return ["tv", "web"].includes(item.type ?? "") &&
    (Boolean(item.broadcast) || (!requireBroadcast && Boolean(item.begin)));
}

/** A subject's broadcasts in a window, and the Japan date it premiered. */
export type Airing = { times: Date[]; premiere?: string };

/** Each Bangumi subject the schedule lists between [start] and [end]. */
export function airingBySubject(data: BangumiData, start: Date, end: Date): Map<number, Airing> {
  const airing = new Map<number, Airing>();
  for (const item of data.items ?? []) {
    if (!scheduled(item)) continue;
    const times = broadcastsOf(item, start, end);
    if (!times?.length) continue;
    const id = subjectIdFromSites(pickSites(item.sites ?? []));
    if (id == null) continue;
    const entry = airing.get(id);
    if (entry) {
      entry.times = [...entry.times, ...times].sort((a, b) => a.getTime() - b.getTime());
    } else {
      airing.set(id, { times, premiere: japanDate(item.begin) });
    }
  }
  return airing;
}

function japanDate(value: string | undefined): string | undefined {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** When [item] airs between [start] and [end]; null without a rule to follow. */
export function broadcastsOf(item: BangumiDataItem, start: Date, end: Date): Date[] | null {
  const broadcast = item.broadcast ? parseBroadcast(item.broadcast) : parseBeginFallback(item.begin);
  if (!broadcast) return null;

  const itemEnd = item.end ? new Date(item.end) : null;
  const hardEnd = itemEnd && itemEnd < end ? itemEnd : end;

  if (broadcast.period === "P0D") {
    return broadcast.start >= start && broadcast.start < hardEnd ? [broadcast.start] : [];
  }
  if (broadcast.period === "P1D" || broadcast.period === "P7D") {
    const step = broadcast.period === "P1D" ? MS_DAY : 7 * MS_DAY;
    const firstOffset = Math.max(0, Math.floor((start.getTime() - broadcast.start.getTime()) / step) - 1);
    const occurrences: Date[] = [];
    for (let time = broadcast.start.getTime() + firstOffset * step; time < hardEnd.getTime(); time += step) {
      if (time >= start.getTime()) occurrences.push(new Date(time));
    }
    return occurrences;
  }
  const occurrences: Date[] = [];
  let current = new Date(broadcast.start);
  while (current < start) current = addUtcMonths(current, 1);
  while (current < hardEnd) {
    occurrences.push(current);
    current = addUtcMonths(current, 1);
  }
  return occurrences;
}

function parseBroadcast(rule: string): { start: Date; period: "P0D" | "P1D" | "P7D" | "P1M" } | null {
  const match = /^R\/(.+)\/(P(?:0D|1D|7D|1M))$/.exec(rule);
  if (!match) return null;
  const start = new Date(match[1]!);
  if (Number.isNaN(start.getTime())) return null;
  return { start, period: match[2] as "P0D" | "P1D" | "P7D" | "P1M" };
}

function parseBeginFallback(begin: string | undefined): { start: Date; period: "P7D" } | null {
  if (!begin) return null;
  const start = new Date(begin);
  if (Number.isNaN(start.getTime())) return null;
  return { start, period: "P7D" };
}

function addUtcMonths(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + amount);
  return next;
}

export function pickSites(sites: NonNullable<BangumiDataItem["sites"]>): ScheduleOccurrence["sites"] {
  const wanted = new Set(["bangumi", "mal", "anilist", "anidb", "kitsu"]);
  return sites
    .filter((site) => wanted.has(site.site))
    .map((site) => ({ site: site.site, id: site.id ?? null, url: site.url ?? null }));
}
