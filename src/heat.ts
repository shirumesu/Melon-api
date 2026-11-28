import { airingBySubject, loadBangumiData } from "./bangumi_data";
import { getOrSetJson, cacheKey } from "./cache";
import {
  addWeeks,
  CRON_INTERVAL_SECONDS,
  loadAiringSubjects,
  matchEpisode,
  pending,
  previousEpisode,
  weekOf,
  type FetchBudget,
  type RefreshMode,
  type ScheduleSubject,
} from "./schedule_subjects";
import type { Env, SubjectListItem } from "./types";
import { currentShanghaiDate, shanghaiDayStart } from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back heat may be asked for: as far as episodes are kept. */
export const HEAT_WEEKS_BACK = 6;

/** A show's heat in a week, and what it was made of. */
export type ShowHeat = {
  subjectId: number;
  /** 0 to 100 among the week's shows. */
  heat: number;
  /** The week before's; absent for a show not broadcast then. */
  previousHeat?: number;
  /** The episode comments counted (see [weekComments]). */
  comments: number;
  /** Collections gained in the week and the week before, once counted. */
  gain?: number;
  previousGain?: number;
  /** Bangumi users watching it now. */
  watching?: number;
};

export type WeekHeat = {
  week: string;
  generatedAt: string;
  /** When the week's collection count began; absent before any was kept. */
  since?: string;
  /** The week's shows still waiting for details or episodes, so without heat. */
  incomplete: number;
  /** By heat, highest first. */
  shows: ShowHeat[];
};

/**
 * [week]'s heat, kept 15 minutes for the current week (a minute while some
 * shows are still incomplete) and 6 hours for others. The cron recomputes
 * the current week's on every run, after refreshing what it counts.
 */
export function loadWeekHeat(
  env: Env,
  week: string,
  budget: FetchBudget,
  mode: RefreshMode,
  options: { force?: boolean; background?: (task: Promise<unknown>) => void } = {},
) {
  const current = weekOf(currentShanghaiDate());
  return getOrSetJson<WeekHeat>(
    env,
    cacheKey(["heat-v1", week]),
    {
      ttlSeconds: (value) => week !== current ? 6 * 60 * 60 : value.incomplete > 0 ? 60 : CRON_INTERVAL_SECONDS,
      staleWhileRevalidateSeconds: 60 * 60,
      force: options.force,
      refreshAheadSeconds: mode === "cron" ? CRON_INTERVAL_SECONDS : undefined,
    },
    () => computeWeekHeat(env, week, current, budget, mode, options.background),
    options.background,
  );
}

/** What heat counts, and how much of it. */
const HEAT_PARTS = [
  { weight: 0.35, value: (show: HeatInput) => show.gain },
  { weight: 0.35, value: (show: HeatInput) => show.comments },
  { weight: 0.3, value: (show: HeatInput) => show.watching },
];

type HeatInput = { id: number; gain?: number; comments: number; watching?: number };

/**
 * Each of [week]'s shows' heat in it and the week before: collections
 * gained, episode comments and Bangumi users watching, each taken as the
 * square root of its share of the week's highest so one hit does not flatten
 * the rest, then weighted 35/35/30. A show whose gain is not counted yet is
 * scored on the other two. A later week has none yet.
 */
async function computeWeekHeat(
  env: Env,
  week: string,
  current: string,
  budget: FetchBudget,
  mode: RefreshMode,
  background?: (task: Promise<unknown>) => void,
): Promise<WeekHeat> {
  const generatedAt = new Date().toISOString();
  if (week > current) return { week, generatedAt, incomplete: 0, shows: [] };
  const previousWeek = addWeeks(week, -1);
  const start = shanghaiDayStart(week).getTime();
  const data = await loadBangumiData(env, false, background);
  const airing = airingBySubject(data, shanghaiDayStart(previousWeek), shanghaiDayStart(addWeeks(week, 1)));
  const thisWeek = new Map<number, Date[]>(), lastWeek = new Map<number, Date[]>();
  for (const [id, { times }] of airing) {
    const now = times.filter((time) => time.getTime() >= start);
    const before = times.filter((time) => time.getTime() < start);
    if (now.length) thisWeek.set(id, now);
    if (before.length) lastWeek.set(id, before);
  }
  const ids = [...thisWeek.keys()];
  // The current week also keeps counts of last week's shows that ended,
  // so last week's gains can still be measured against this week's start.
  const counted = week === current ? [...new Set([...ids, ...lastWeek.keys()])] : ids;
  const subjects = await loadAiringSubjects(env, airing, counted, budget, mode, background);
  const gains = env.DB ? await collectionGains(env.DB, week, current, subjects, counted) : undefined;

  const now = Date.now();
  const shows = ids.flatMap((id) => {
    const entry = subjects.get(id)!;
    return entry.brief ? [{ id, entry, brief: entry.brief }] : [];
  });
  const comments = new Map(shows.map(({ id, entry }) => [id, weekComments(entry, thisWeek.get(id)!, now)]));
  const heat = heatScores(shows.map(({ id, brief }) => ({
    id,
    gain: gains?.byId.get(id)?.gain,
    comments: comments.get(id)!,
    watching: brief.collectionStats?.watching,
  })));
  const previousHeat = heatScores(shows
    .filter(({ id }) => lastWeek.has(id))
    .map(({ id, entry, brief }) => ({
      id,
      gain: gains?.byId.get(id)?.previous,
      comments: weekComments(entry, lastWeek.get(id)!, now),
      watching: brief.collectionStats?.watching,
    })));
  return {
    week,
    generatedAt,
    ...(gains?.since ? { since: gains.since } : {}),
    incomplete: ids.filter((id) => pending(subjects.get(id))).length,
    shows: shows
      .map(({ id, brief }): ShowHeat => {
        const gain = gains?.byId.get(id);
        return {
          subjectId: id,
          heat: heat.get(id)!,
          ...(previousHeat.has(id) ? { previousHeat: previousHeat.get(id) } : {}),
          comments: comments.get(id)!,
          ...(gain ? { gain: gain.gain, ...(gain.previous != null ? { previousGain: gain.previous } : {}) } : {}),
          ...(brief.collectionStats ? { watching: brief.collectionStats.watching } : {}),
        };
      })
      .sort((a, b) => b.heat - a.heat),
  };
}

function heatScores(shows: HeatInput[]): Map<number, number> {
  const parts = HEAT_PARTS.map((part) => ({
    ...part,
    top: shows.reduce((top, show) => Math.max(top, part.value(show) ?? 0), 0),
  }));
  return new Map(shows.map((show) => {
    let sum = 0, weights = 0;
    for (const part of parts) {
      const value = part.value(show);
      if (value == null || part.top <= 0) continue;
      sum += part.weight * Math.sqrt(Math.max(0, value) / part.top);
      weights += part.weight;
    }
    return [show.id, weights ? Math.round((1000 * sum) / weights) / 10 : 0];
  }));
}

/**
 * The comments on a show's episode of a week, which it broadcast at
 * [broadcasts]: the latest one aired by [now], or, while that is under two
 * days old, the one before it when that has more; before the week's first
 * airs, the one before that. None when no broadcast has an episode, as in a
 * week off.
 */
function weekComments(entry: ScheduleSubject, broadcasts: Date[], now: number): number {
  const matched = broadcasts.flatMap((time) => {
    const episode = matchEpisode(entry, time);
    return episode ? [{ at: time.getTime(), episode }] : [];
  });
  const first = matched[0];
  if (!first) return 0;
  const latest = matched.filter(({ at }) => at <= now).at(-1);
  if (!latest) return previousEpisode(entry, first.episode)?.comments ?? 0;
  const before = previousEpisode(entry, latest.episode);
  return now - latest.at < 2 * DAY_MS && before
    ? Math.max(latest.episode.comments, before.comments)
    : latest.episode.comments;
}

function collectionTotal(subject: SubjectListItem | undefined): number | undefined {
  const stats = subject?.collectionStats;
  return stats && stats.wish + stats.watching + stats.completed + stats.on_hold + stats.dropped;
}

/**
 * Collections each of [ids] gained in [week]: until now for the current
 * week, between its start and the next week's start for an earlier one; and
 * in the week before. In the current week it first keeps the collection
 * count of each subject not counted yet whose details are from this week:
 * the start of its count.
 */
async function collectionGains(
  db: D1Database,
  week: string,
  current: string,
  subjects: Map<number, ScheduleSubject>,
  ids: number[],
): Promise<{ since?: string; byId: Map<number, { gain: number; previous?: number }> }> {
  const weeks = [addWeeks(week, -1), week, addWeeks(week, 1)];
  const { results } = await db.prepare(
    "SELECT week, subject, total, recorded FROM collection_snapshots WHERE week IN (?1, ?2, ?3)",
  ).bind(...weeks).all<{ week: string; subject: number; total: number; recorded: number }>();
  const counts = new Map<string, { total: number; recorded: number }>();
  for (const row of results) counts.set(`${row.week}/${row.subject}`, row);
  if (week === current) await recordStarts(db, week, subjects, ids, counts);

  const byId = new Map<number, { gain: number; previous?: number }>();
  let since: number | undefined;
  for (const id of ids) {
    const entry = subjects.get(id);
    const start = counts.get(`${week}/${id}`);
    if (!entry || !start) continue;
    const end = week === current
      ? entry.briefAt != null && Math.floor(entry.briefAt / 1000) > start.recorded ? collectionTotal(entry.brief) : undefined
      : counts.get(`${weeks[2]}/${id}`)?.total;
    if (end == null) continue;
    const before = counts.get(`${weeks[0]}/${id}`);
    byId.set(id, { gain: end - start.total, ...(before ? { previous: start.total - before.total } : {}) });
    since = Math.min(since ?? start.recorded, start.recorded);
  }
  return { ...(since != null ? { since: new Date(since * 1000).toISOString() } : {}), byId };
}

/** Keeps the week's starting count of [ids] not in [counts] yet; details from before the week would start it early. */
async function recordStarts(
  db: D1Database,
  week: string,
  subjects: Map<number, ScheduleSubject>,
  ids: number[],
  counts: Map<string, { total: number; recorded: number }>,
): Promise<void> {
  const weekStart = shanghaiDayStart(week).getTime();
  const statement = db.prepare(
    "INSERT OR IGNORE INTO collection_snapshots (week, subject, total, recorded) VALUES (?1, ?2, ?3, ?4)",
  );
  const rows = ids.flatMap((id) => {
    const entry = subjects.get(id);
    const total = collectionTotal(entry?.brief);
    if (total == null || entry?.briefAt == null || entry.briefAt < weekStart || counts.has(`${week}/${id}`)) return [];
    const recorded = Math.floor(entry.briefAt / 1000);
    counts.set(`${week}/${id}`, { total, recorded });
    return [statement.bind(week, id, total, recorded)];
  });
  if (rows.length) await db.batch(rows);
}
