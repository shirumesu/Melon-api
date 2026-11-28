import { BangumiClient, subjectIdFromSites } from "./bangumi";
import { airingBySubject, broadcastsOf, loadBangumiData, pickSites, scheduled, type BangumiDataItem } from "./bangumi_data";
import { getOrSetJson } from "./cache";
import { loadWeekHeat, type ShowHeat } from "./heat";
import {
  airingEpisode,
  breakEnd,
  briefSummary,
  loadAiringSubjects,
  pending,
  weekOf,
  type FetchBudget,
  type RefreshMode,
  type ScheduleSubject,
} from "./schedule_subjects";
import type { Env, ScheduleOccurrence, ScheduleResponse, SubjectListItem } from "./types";
import {
  addDays,
  compact,
  currentShanghaiDate,
  formatInShanghai,
  shanghaiDayStart,
  weekdayInShanghai,
} from "./utils";

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
  mode: RefreshMode,
  background?: (task: Promise<unknown>) => void,
): Promise<ScheduleResponse> {
  const centerDate = input.startDate ?? input.date ?? currentShanghaiDate();
  const startDate = input.startDate ?? addDays(centerDate, -input.days);
  const windowStart = shanghaiDayStart(startDate);
  const windowEnd = shanghaiDayStart(input.startDate
    ? addDays(input.startDate, input.dayCount ?? 7)
    : addDays(centerDate, input.days + 1));
  const data = await loadBangumiData(env, input.force, background);
  const airing = airingBySubject(data, windowStart, windowEnd);
  const ids = [...airing.keys()];
  const [subjects, calendar] = await Promise.all([
    loadAiringSubjects(env, airing, ids, budget, mode, background),
    loadCalendar(env, input.force, background),
  ]);
  // Clients 0.4 and earlier read heat from here; later ones ask /v1/schedule/heat.
  const heat = (await loadWeekHeat(env, weekOf(startDate), budget, mode, { background })).value;
  const items = buildSchedule(data.items ?? [], windowStart, windowEnd, {
    requireBroadcast: input.requireBroadcast ?? false,
    includeNsfw: input.includeNsfw ?? false,
    includeUnknownNsfw: input.includeUnknownNsfw ?? true,
    details: enrich(ids, subjects, calendar),
    subjects,
    heat: new Map(heat.shows.map((show) => [show.subjectId, show])),
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
    incomplete: ids.filter((id) => pending(subjects.get(id))).length,
    ...(heat.shows.length ? { heat: { week: heat.week, ...(heat.since ? { since: heat.since } : {}) } } : {}),
  };
}

/** Bangumi's own calendar of airing shows, which carries covers before their details arrive. */
function loadCalendar(
  env: Env,
  force = false,
  background?: (task: Promise<unknown>) => void,
): Promise<SubjectListItem[]> {
  const client = new BangumiClient(env, AbortSignal.timeout(15_000));
  return getOrSetJson(env, "source/calendar", { ttlSeconds: 60 * 60, force }, () => client.getCalendarSubjects(), background)
    .then((result) => result.value)
    .catch((error) => {
      console.warn("Bangumi calendar enrichment unavailable", error);
      return [];
    });
}

/** What each of [ids] shows: the calendar's, then its details, which are fuller. */
function enrich(
  ids: number[],
  subjects: Map<number, ScheduleSubject>,
  calendar: SubjectListItem[],
): Map<number, SubjectListItem> {
  const wanted = new Set(ids);
  const details = new Map<number, SubjectListItem>();
  for (const subject of calendar) if (wanted.has(subject.subjectId)) details.set(subject.subjectId, subject);
  for (const id of ids) {
    const brief = subjects.get(id)?.brief;
    if (!brief) continue;
    const previous = details.get(id);
    // Each value the details have replaces the calendar's.
    details.set(id, {
      ...previous,
      ...compact(brief) as SubjectListItem,
      coverUrl: brief.coverUrl || previous?.coverUrl,
      tags: brief.tags.length ? brief.tags : previous?.tags ?? [],
      metaTags: brief.metaTags.length ? brief.metaTags : previous?.metaTags ?? [],
    });
  }
  return details;
}

function buildSchedule(
  items: BangumiDataItem[],
  start: Date,
  end: Date,
  options: {
    requireBroadcast: boolean;
    includeNsfw: boolean;
    includeUnknownNsfw: boolean;
    details: Map<number, SubjectListItem>;
    subjects: Map<number, ScheduleSubject>;
    heat: Map<number, ShowHeat>;
  },
): ScheduleOccurrence[] {
  const schedule: ScheduleOccurrence[] = [];
  for (const item of items) {
    if (!scheduled(item, options.requireBroadcast)) continue;
    const occurrences = broadcastsOf(item, start, end);
    if (!occurrences) continue;
    const names = pickNames(item);
    const sites = pickSites(item.sites ?? []);
    const subjectId = subjectIdFromSites(sites);
    const enriched = subjectId ? options.details.get(subjectId) : undefined;
    const nsfwStatus = enriched?.nsfw === true ? "nsfw" : enriched?.nsfw === false ? "safe" : "unknown";
    if (!options.includeNsfw && enriched?.nsfw === true) continue;
    if (!options.includeUnknownNsfw && enriched?.nsfw == null) continue;
    const stored = subjectId ? options.subjects.get(subjectId) : undefined;
    const heat = subjectId ? options.heat.get(subjectId) : undefined;

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
        ...(heat
          ? {
            heat: heat.heat,
            previousHeat: heat.previousHeat,
            heatComments: heat.comments,
            collectionGain: heat.gain,
            previousCollectionGain: heat.previousGain,
          }
          : {}),
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

function pickNames(item: BangumiDataItem): { display: string; native: string; zhHans?: string } {
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
  return Array.isArray(values) && typeof values[0] === "string" && values[0].length > 0 ? values[0] : null;
}
