import { BangumiClient, mapLimit } from "./bangumi";
import type { Airing } from "./bangumi_data";
import { cacheKey, getOrSetJson } from "./cache";
import { HttpError, type EpisodeBrief, type Env, type ScheduleOccurrence, type SubjectListItem } from "./types";

const STORE_KEY = "schedule/subjects-v1";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const JST_OFFSET_MS = 9 * HOUR_MS;

/** How often the cron in wrangler.toml runs. */
export const CRON_INTERVAL_SECONDS = 15 * 60;
const CRON_INTERVAL_MS = CRON_INTERVAL_SECONDS * 1000;

/**
 * Most airing subjects' details and counts come from the list of anime
 * premiering in their month, one request for up to a hundred, kept this
 * fresh; a month joins once this many of a window's subjects premiered in it.
 */
const MONTH_TTL_SECONDS = 30 * 60;
const MONTH_MIN_SUBJECTS = 3;
/** Details of a subject outside those lists, such as a year-round show. */
const BRIEF_TTL_MS = 2 * HOUR_MS;
/** Episodes while one aired today or yesterday (Japan), within three days, and otherwise. */
const EPISODES_TTL_MS = [HOUR_MS, 3 * HOUR_MS, 12 * HOUR_MS] as const;
// Entries no schedule asked for in three weeks are dropped.
const RETENTION_MS = 21 * DAY_MS;
// Episodes kept around now: enough to match the weeks clients browse.
const EPISODES_BEFORE_MS = 42 * DAY_MS;
const EPISODES_AFTER_MS = 21 * DAY_MS;
/** How long an isolate uses its copy of the store before asking R2 whether it changed. */
const STORE_RECHECK_MS = MINUTE_MS;

/** What melon-api last fetched of one airing subject. */
export type ScheduleSubject = {
  brief?: SubjectListItem;
  briefAt?: number;
  /** Main episodes dated within a few weeks of when they were fetched. */
  episodes?: EpisodeBrief[];
  episodesAt?: number;
  /** Main episodes Bangumi lists, and the highest sort among them. */
  episodeCount?: number;
  lastSort?: number;
  usedAt: number;
};

/**
 * Bangumi requests this invocation may still make. Workers Free stops an
 * invocation's 51st external request, so the schedule takes a share of it
 * and leaves the rest of its subjects to later requests and the cron.
 */
export class FetchBudget {
  constructor(private left: number) {}

  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }

  /** Spends what is left, as when Bangumi asks to slow down. */
  stop(): void {
    this.left = 0;
  }
}

/** A load the invocation's [FetchBudget] could not pay for. */
export class BudgetSpent extends Error {
  constructor() {
    super("This invocation has used its share of Bangumi requests.");
  }
}

/**
 * The cron refreshes whatever falls due before its next run; a request
 * fetches what is missing, and what is overdue by more than a run, as when
 * the cron stops.
 */
export type RefreshMode = "cron" | "request";

function due(at: number | undefined, ttl: number, now: number, mode: RefreshMode): boolean {
  return at == null || now - at > ttl + (mode === "cron" ? -CRON_INTERVAL_MS : CRON_INTERVAL_MS);
}

/**
 * Everything known of [ids], which [airing] describes: details and counts
 * from their premiere months' lists where those hold them, otherwise from
 * each subject's own; and episodes. What is missing or due is fetched first,
 * as far as [budget] allows.
 */
export async function loadAiringSubjects(
  env: Env,
  airing: Map<number, Airing>,
  ids: number[],
  budget: FetchBudget,
  mode: RefreshMode,
  background?: (task: Promise<unknown>) => void,
): Promise<Map<number, ScheduleSubject>> {
  const lists = await Promise.all(premiereMonths(airing, ids).map((month) =>
    loadPremiereMonth(env, month, budget, mode, background).catch((error) => {
      // Its subjects then wait for their own details, counted as incomplete.
      if (!(error instanceof BudgetSpent)) console.warn(`Premiere month ${month} unavailable`, error);
      return null;
    })));
  const listed: Listed = new Map();
  for (const list of lists) {
    for (const brief of list?.items ?? []) listed.set(brief.subjectId, { brief, at: list!.at });
  }
  const run = storeQueue.then(() => refresh(env, ids, listed, budget, mode));
  storeQueue = run.catch(() => undefined);
  return run;
}

type Listed = Map<number, { brief: SubjectListItem; at: number }>;

/** The months, `YYYY-MM`, in which at least [MONTH_MIN_SUBJECTS] of [ids] premiered. */
function premiereMonths(airing: Map<number, Airing>, ids: number[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const month = airing.get(id)?.premiere?.slice(0, 7);
    if (month) counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= MONTH_MIN_SUBJECTS).map(([month]) => month);
}

async function loadPremiereMonth(
  env: Env,
  month: string,
  budget: FetchBudget,
  mode: RefreshMode,
  background?: (task: Promise<unknown>) => void,
): Promise<{ items: SubjectListItem[]; at: number }> {
  const result = await getOrSetJson(
    env,
    cacheKey(["premiere-month-v1", month]),
    {
      ttlSeconds: MONTH_TTL_SECONDS,
      staleWhileRevalidateSeconds: 7 * 24 * 60 * 60,
      refreshAheadSeconds: mode === "cron" ? CRON_INTERVAL_SECONDS : undefined,
    },
    async () => {
      const client = new BangumiClient(env, AbortSignal.timeout(20_000));
      const items: SubjectListItem[] = [];
      for (;;) {
        if (!budget.take()) throw new BudgetSpent();
        const page = await client.browseMonth(month, items.length).catch((error) => {
          if (error instanceof HttpError && error.status === 429) budget.stop();
          throw error;
        });
        items.push(...page.data.map(slim));
        if (page.data.length === 0 || items.length >= page.total) return items;
      }
    },
    background,
  );
  return { items: result.value, at: Date.parse(result.cache.cachedAt) };
}

let storeQueue: Promise<unknown> = Promise.resolve();

/**
 * The store's entries for [ids], first fetching what is missing or due:
 * missing details first, then missing episodes, then the most overdue. One
 * stored object holds every subject, so a schedule reads it once; updates
 * in one isolate run in turn, and ones racing in other isolates merge.
 */
async function refresh(
  env: Env,
  ids: number[],
  listed: Listed,
  budget: FetchBudget,
  mode: RefreshMode,
): Promise<Map<number, ScheduleSubject>> {
  const now = Date.now();
  const base = await readStore(env);
  const store = new Map<number, ScheduleSubject>();
  for (const [id, entry] of Object.entries(base.value)) {
    if (now - entry.usedAt <= RETENTION_MS) store.set(Number(id), { ...entry });
  }
  let changed = store.size !== Object.keys(base.value).length;
  for (const id of ids) {
    const entry = store.get(id) ?? { usedAt: now };
    entry.usedAt = now;
    // A listed subject's own details would only go stale.
    if (listed.has(id) && entry.briefAt != null) {
      delete entry.brief;
      delete entry.briefAt;
      changed = true;
    }
    store.set(id, entry);
  }

  const jobs = ids
    .flatMap((id) => {
      const entry = store.get(id)!;
      return [
        ...(listed.has(id) ? [] : [{ id, kind: "brief" as const, at: entry.briefAt, ttl: BRIEF_TTL_MS }]),
        { id, kind: "episodes" as const, at: entry.episodesAt, ttl: episodesTtl(entry, now) },
      ];
    })
    .filter((job) => due(job.at, job.ttl, now, mode))
    .sort((a, b) =>
      Number(a.at != null) - Number(b.at != null) ||
      Number(a.kind === "episodes") - Number(b.kind === "episodes") ||
      (a.at ?? 0) + a.ttl - ((b.at ?? 0) + b.ttl));

  const client = new BangumiClient(env, AbortSignal.timeout(20_000));
  // Six at a time: a Worker keeps at most six connections open.
  await mapLimit(jobs, 6, async (job) => {
    if (!budget.take()) return;
    const entry = store.get(job.id)!;
    try {
      if (job.kind === "brief") {
        entry.brief = slim(await client.getSubject(job.id));
        entry.briefAt = Date.now();
      } else {
        await fetchEpisodes(client, job.id, entry, budget);
      }
      changed = true;
    } catch (error) {
      // A subject Bangumi no longer has waits like a fetched one; any other
      // failure leaves it as it was, counted as incomplete, for the next
      // request to try.
      if (error instanceof HttpError && error.status === 404) {
        if (job.kind === "brief") entry.briefAt = Date.now();
        else entry.episodesAt = Date.now();
        changed = true;
        return;
      }
      if (error instanceof HttpError && error.status === 429) budget.stop();
      console.warn(`Schedule subject ${job.id} ${job.kind} unavailable`, error);
    }
  });

  const saved = changed ? await writeStore(env, base, Object.fromEntries(store)) : base.value;
  return new Map(ids.map((id) => {
    const entry = saved[id] ?? store.get(id)!;
    const list = listed.get(id);
    return [id, list ? { ...entry, brief: list.brief, briefAt: list.at } : entry];
  }));
}

/** Episodes refresh hourly around a new one, while its comments pile up. */
function episodesTtl(entry: ScheduleSubject, now: number): number {
  const today = japanDate(now);
  const latest = (entry.episodes ?? []).reduce((last, episode) =>
    episode.airdate <= today && episode.airdate > last ? episode.airdate : last, "");
  if (!latest) return EPISODES_TTL_MS[2];
  const days = (Date.parse(today) - Date.parse(latest)) / DAY_MS;
  return days <= 1 ? EPISODES_TTL_MS[0] : days <= 3 ? EPISODES_TTL_MS[1] : EPISODES_TTL_MS[2];
}

async function fetchEpisodes(client: BangumiClient, id: number, entry: ScheduleSubject, budget: FetchBudget) {
  const count = entry.episodeCount;
  let page = await client.getMainEpisodes(id, count ? Math.max(0, count - 100) : 0);
  if (page.total > 100 && count !== page.total) {
    // The newest episodes are the last page; without the budget for it
    // the count still lets the next request fetch it directly.
    entry.episodeCount = page.total;
    if (!budget.take()) return;
    page = await client.getMainEpisodes(id, page.total - 100);
  }
  const fetched = Date.now();
  entry.episodes = page.data.filter((episode) => {
    const day = Date.parse(`${episode.airdate}T00:00:00+09:00`);
    return day >= fetched - EPISODES_BEFORE_MS && day <= fetched + EPISODES_AFTER_MS;
  });
  entry.episodeCount = page.total;
  entry.lastSort = page.data.reduce((last, episode) => Math.max(last, episode.sort), 0) || undefined;
  entry.episodesAt = fetched;
}

type StoreValue = Record<string, ScheduleSubject>;
type StoreCopy = { value: StoreValue; etag?: string; checkedAt: number };
let storeCopy: StoreCopy | undefined;

/** The stored subjects, from memory while recently checked against R2. */
async function readStore(env: Env): Promise<StoreCopy> {
  const now = Date.now();
  if (storeCopy && now - storeCopy.checkedAt < STORE_RECHECK_MS) return storeCopy;
  const bucket = env.CACHE_BUCKET;
  if (!bucket) return storeCopy = { value: storeCopy?.value ?? {}, checkedAt: now };
  const known = storeCopy;
  const object = known?.etag
    ? await bucket.get(STORE_KEY, { onlyIf: { etagDoesNotMatch: known.etag } })
    : await bucket.get(STORE_KEY);
  if (!object) return storeCopy = { value: {}, checkedAt: now };
  // Without a body R2 says the copy is current.
  if (!("body" in object)) return storeCopy = { ...known!, checkedAt: now };
  const stored = await (object as R2ObjectBody).json<{ value: StoreValue }>();
  return storeCopy = { value: stored.value, etag: object.etag, checkedAt: now };
}

/**
 * Writes [value] over [base] unless another isolate wrote since, in which
 * case it merges onto that copy, keeping each subject's newer details and
 * episodes, and tries again.
 */
async function writeStore(env: Env, base: StoreCopy, value: StoreValue): Promise<StoreValue> {
  const bucket = env.CACHE_BUCKET;
  if (!bucket) {
    storeCopy = { value, checkedAt: Date.now() };
    return value;
  }
  let current = base;
  let next = value;
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const cachedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + RETENTION_MS).toISOString();
    const written = await bucket.put(STORE_KEY, JSON.stringify({ value: next, cachedAt, expiresAt }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { cachedAt, expiresAt },
      ...(current.etag ? { onlyIf: { etagMatches: current.etag } } : {}),
    });
    if (written) {
      storeCopy = { value: next, etag: written.etag, checkedAt: now };
      return next;
    }
    storeCopy = undefined;
    current = await readStore(env);
    next = mergeStores(current.value, next, now);
  }
  throw new Error("The schedule store kept changing while being written.");
}

function mergeStores(theirs: StoreValue, mine: StoreValue, now: number): StoreValue {
  const merged: StoreValue = {};
  for (const id of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const a = theirs[id], b = mine[id];
    const entry = a && b ? mergeEntries(a, b) : (a ?? b)!;
    if (now - entry.usedAt <= RETENTION_MS) merged[id] = entry;
  }
  return merged;
}

function mergeEntries(a: ScheduleSubject, b: ScheduleSubject): ScheduleSubject {
  const details = (a.briefAt ?? 0) >= (b.briefAt ?? 0) ? a : b;
  const episodes = (a.episodesAt ?? 0) >= (b.episodesAt ?? 0) ? a : b;
  return {
    brief: details.brief,
    briefAt: details.briefAt,
    episodes: episodes.episodes,
    episodesAt: episodes.episodesAt,
    episodeCount: episodes.episodeCount,
    lastSort: episodes.lastSort,
    usedAt: Math.max(a.usedAt, b.usedAt),
  };
}

/** A schedule's share of the details: a short summary and the leading tags. */
function slim(subject: SubjectListItem): SubjectListItem {
  return {
    ...subject,
    summary: briefSummary(subject.summary),
    shortSummary: undefined,
    tags: subject.tags.slice(0, 12),
  };
}

/** A summary's first 200 characters on one line. */
export function briefSummary(summary: string | undefined): string | undefined {
  const line = summary?.replace(/\s+/g, " ").trim();
  return line && line.length > 200 ? `${line.slice(0, 200)}…` : line || undefined;
}

/** Whether a subject still waits for its first details or episodes. */
export function pending(entry: ScheduleSubject | undefined): boolean {
  return entry?.briefAt == null || entry.episodesAt == null;
}

/**
 * The main episode dated the broadcast's day in Japan, or a day either
 * side (Bangumi dates episodes where they first air); the nearest wins.
 */
export function matchEpisode(subject: ScheduleSubject, broadcast: Date): EpisodeBrief | undefined {
  const day = Date.parse(japanDate(broadcast.getTime()));
  let best: { distance: number; episode: EpisodeBrief } | undefined;
  for (const episode of subject.episodes ?? []) {
    const distance = Math.abs(Date.parse(episode.airdate) - day);
    if (distance > DAY_MS) continue;
    if (!best || distance < best.distance || (distance === best.distance && episode.sort < best.episode.sort)) {
      best = { distance, episode };
    }
  }
  return best?.episode;
}

/**
 * [matchEpisode], and whether it is the final one: the last listed, reaching
 * the planned count of at most 60, which year-round shows do not have.
 */
export function airingEpisode(
  subject: ScheduleSubject,
  broadcast: Date,
  episodeTotal: number | undefined,
): ScheduleOccurrence["episode"] {
  const episode = matchEpisode(subject, broadcast);
  if (!episode) return undefined;
  const number = episode.ep ?? episode.sort;
  const final = episodeTotal != null && episodeTotal <= 60 && number >= episodeTotal &&
    episode.sort === subject.lastSort;
  return { ...episode, final };
}

/** The main episode before [episode], by sort. */
export function previousEpisode(subject: ScheduleSubject, episode: EpisodeBrief): EpisodeBrief | undefined {
  let best: EpisodeBrief | undefined;
  for (const other of subject.episodes ?? []) {
    if (other.sort < episode.sort && (!best || other.sort > best.sort)) best = other;
  }
  return best;
}

/**
 * The day the next episode airs, when Bangumi dates episodes before and
 * after this broadcast but none on its day: the show takes this week off.
 */
export function breakEnd(subject: ScheduleSubject, broadcast: Date): string | undefined {
  const day = Date.parse(japanDate(broadcast.getTime()));
  const dates = (subject.episodes ?? []).map((episode) => episode.airdate).sort();
  const next = dates.find((date) => Date.parse(date) > day + DAY_MS);
  return next && dates.some((date) => Date.parse(date) < day - DAY_MS) ? next : undefined;
}

/** The date, YYYY-MM-DD, in Japan at [time]. */
function japanDate(time: number): string {
  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Monday, YYYY-MM-DD in Shanghai, of the week holding [date]. */
export function weekOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = Date.UTC(year!, month! - 1, day!);
  const weekday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - weekday * DAY_MS).toISOString().slice(0, 10);
}

export function addWeeks(week: string, amount: number): string {
  return new Date(Date.parse(`${week}T00:00:00Z`) + amount * 7 * DAY_MS).toISOString().slice(0, 10);
}
