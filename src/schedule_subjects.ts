import { BangumiClient, mapLimit } from "./bangumi";
import { readJson, writeJson } from "./cache";
import { HttpError, type EpisodeBrief, type Env, type SubjectListItem } from "./types";
import { shanghaiDateString } from "./utils";

const STORE_KEY = "schedule/subjects-v1";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BRIEF_TTL_MS = 6 * HOUR_MS;
const EPISODES_TTL_MS = 12 * HOUR_MS;
// Entries no schedule asked for in three weeks are dropped.
const RETENTION_MS = 21 * DAY_MS;
// Episodes kept around now: enough to match the weeks clients browse.
const EPISODES_BEFORE_MS = 42 * DAY_MS;
const EPISODES_AFTER_MS = 21 * DAY_MS;

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
}

let storeQueue: Promise<unknown> = Promise.resolve();

/**
 * The stored details of [subjectIds], first fetching what is missing or
 * out of date as far as [budget] allows: missing details first, then
 * missing episodes, then the oldest. One stored object holds every
 * subject, so a schedule reads it once; updates in one isolate run in turn.
 */
export function loadScheduleSubjects(
  env: Env,
  subjectIds: number[],
  budget: FetchBudget,
): Promise<Map<number, ScheduleSubject>> {
  const run = storeQueue.then(() => refresh(env, subjectIds, budget));
  storeQueue = run.catch(() => undefined);
  return run;
}

async function refresh(
  env: Env,
  subjectIds: number[],
  budget: FetchBudget,
): Promise<Map<number, ScheduleSubject>> {
  const now = Date.now();
  const stored = await readJson<Record<string, ScheduleSubject>>(env, STORE_KEY, { allowExpired: true });
  const store = new Map<number, ScheduleSubject>();
  for (const [id, entry] of Object.entries(stored?.value ?? {})) {
    if (now - entry.usedAt <= RETENTION_MS) store.set(Number(id), { ...entry });
  }
  for (const id of subjectIds) {
    const entry = store.get(id);
    store.set(id, entry ? { ...entry, usedAt: now } : { usedAt: now });
  }

  const jobs = subjectIds
    .flatMap((id) => {
      const entry = store.get(id)!;
      return [
        { id, kind: "brief" as const, at: entry.briefAt, ttl: BRIEF_TTL_MS },
        { id, kind: "episodes" as const, at: entry.episodesAt, ttl: EPISODES_TTL_MS },
      ];
    })
    .filter((job) => job.at == null || now - job.at > job.ttl)
    .sort((a, b) =>
      Number(a.at != null) - Number(b.at != null) ||
      Number(a.kind === "episodes") - Number(b.kind === "episodes") ||
      (a.at ?? 0) - (b.at ?? 0));

  const client = new BangumiClient(env, AbortSignal.timeout(20_000));
  let changed = false;
  // Six at a time: a Worker keeps at most six connections open.
  await mapLimit(jobs, 6, async (job) => {
    if (!budget.take()) return;
    const entry = store.get(job.id)!;
    try {
      if (job.kind === "brief") {
        entry.brief = slim(await client.getSubject(job.id));
        entry.briefAt = Date.now();
        changed = true;
        return;
      }
      const count = entry.episodeCount;
      let page = await client.getMainEpisodes(job.id, count ? Math.max(0, count - 100) : 0);
      if (page.total > 100 && count !== page.total) {
        // The newest episodes are the last page; without the budget for it
        // the count still lets the next request fetch it directly.
        entry.episodeCount = page.total;
        changed = true;
        if (!budget.take()) return;
        page = await client.getMainEpisodes(job.id, page.total - 100);
      }
      const fetched = Date.now();
      entry.episodes = page.data.filter((episode) => {
        const day = Date.parse(`${episode.airdate}T00:00:00+09:00`);
        return day >= fetched - EPISODES_BEFORE_MS && day <= fetched + EPISODES_AFTER_MS;
      });
      entry.episodeCount = page.total;
      entry.lastSort = page.data.reduce((last, episode) => Math.max(last, episode.sort), 0) || undefined;
      entry.episodesAt = fetched;
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
      console.warn(`Schedule subject ${job.id} ${job.kind} unavailable`, error);
    }
  });

  if (changed || store.size !== Object.keys(stored?.value ?? {}).length) {
    await writeJson(env, STORE_KEY, {
      value: Object.fromEntries(store),
      cachedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RETENTION_MS).toISOString(),
    });
  }
  if (changed) await recordSnapshots(env, store);
  return store;
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

/** The Monday, YYYY-MM-DD in Shanghai, of the week holding [date]. */
export function weekOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = Date.UTC(year!, month! - 1, day!);
  const weekday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - weekday * DAY_MS).toISOString().slice(0, 10);
}

function addWeeks(week: string, amount: number): string {
  return new Date(Date.parse(`${week}T00:00:00Z`) + amount * 7 * DAY_MS).toISOString().slice(0, 10);
}

function collectionTotal(subject: SubjectListItem | undefined): number | undefined {
  const stats = subject?.collectionStats;
  return stats && stats.wish + stats.watching + stats.completed + stats.on_hold + stats.dropped;
}

/**
 * Keeps each subject's collection count the first time this week its
 * details were fresh: the start of the week's new-collection count.
 */
async function recordSnapshots(env: Env, store: Map<number, ScheduleSubject>): Promise<void> {
  if (!env.DB) return;
  const week = weekOf(shanghaiDateString(new Date()));
  const weekStart = Date.parse(`${week}T00:00:00+08:00`);
  const statement = env.DB.prepare(
    "INSERT OR IGNORE INTO collection_snapshots (week, subject, total, recorded) VALUES (?1, ?2, ?3, ?4)",
  );
  const rows = [...store].flatMap(([id, entry]) => {
    const total = collectionTotal(entry.brief);
    // Details from before the week would start the count early.
    return total != null && entry.briefAt != null && entry.briefAt >= weekStart
      ? [statement.bind(week, id, total, Math.floor(entry.briefAt / 1000))]
      : [];
  });
  if (rows.length) await env.DB.batch(rows);
}

export type WeeklyHeat = {
  week: string;
  since: string;
  gains: Map<number, { gain: number; previous?: number }>;
};

/**
 * Collections each subject gained in [week]: until now for the current
 * week, between its start and the next week's start for an earlier one.
 * Null for a later week, without D1, or before any count was kept.
 */
export async function weeklyHeat(
  env: Env,
  week: string,
  store: Map<number, ScheduleSubject>,
): Promise<WeeklyHeat | null> {
  const current = weekOf(shanghaiDateString(new Date()));
  if (!env.DB || week > current) return null;
  const weeks = [addWeeks(week, -1), week, addWeeks(week, 1)];
  const { results } = await env.DB.prepare(
    "SELECT week, subject, total, recorded FROM collection_snapshots WHERE week IN (?1, ?2, ?3)",
  ).bind(...weeks).all<{ week: string; subject: number; total: number; recorded: number }>();
  const counts = new Map<string, { total: number; recorded: number }>();
  for (const row of results) counts.set(`${row.week}/${row.subject}`, row);
  const gains = new Map<number, { gain: number; previous?: number }>();
  let since: number | undefined;
  for (const [id, entry] of store) {
    const start = counts.get(`${week}/${id}`);
    if (!start) continue;
    const end = week === current
      ? entry.briefAt != null && Math.floor(entry.briefAt / 1000) > start.recorded ? collectionTotal(entry.brief) : undefined
      : counts.get(`${weeks[2]}/${id}`)?.total;
    if (end == null) continue;
    const before = counts.get(`${weeks[0]}/${id}`);
    gains.set(id, { gain: end - start.total, ...(before ? { previous: start.total - before.total } : {}) });
    since = Math.min(since ?? start.recorded, start.recorded);
  }
  return since == null ? null : { week, since: new Date(since * 1000).toISOString(), gains };
}
