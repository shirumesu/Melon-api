import { cacheKey, getOrSetJson } from "./cache";
import { HttpError } from "./types";
import type {
  Env,
  ImageSet,
  Paged,
  SubjectListItem,
} from "./types";
import {
  baseApi,
  baseWeb,
  pickDisplayName,
  pickImage,
  positiveNumber,
  seasonFromDate,
  toInt,
  userAgent,
} from "./utils";

type SearchSubjectsResponse = {
  total?: number;
  limit?: number;
  offset?: number;
  data: BangumiSubject[];
};

type BangumiSubject = {
  id: number;
  type?: number;
  name: string;
  name_cn?: string;
  summary?: string;
  nsfw?: boolean;
  short_summary?: string;
  date?: string;
  platform?: string;
  eps?: number;
  total_episodes?: number;
  images?: ImageSet | null;
  rating?: {
    rank?: number;
    total?: number;
    score?: number;
    count?: Record<string, number>;
  };
  collection?: {
    wish?: number;
    collect?: number;
    doing?: number;
    on_hold?: number;
    dropped?: number;
  };
  tags?: Array<{ name: string; count?: number }>;
  meta_tags?: string[];
};

type CalendarResponse = Array<{
  weekday: {
    en: string;
    cn: string;
    ja?: string;
    id: number;
  };
  items: BangumiSubject[];
}>;

export type SearchInput = {
  q: string;
  limit: number;
  offset: number;
  sort: "match" | "heat" | "rank" | "score";
  tags: string[];
  metaTags: string[];
  airDates: string[];
  ratings: string[];
  ranks: string[];
  includeNsfw: boolean;
};

export class BangumiClient {
  constructor(private readonly env: Env, private readonly signal?: AbortSignal) {}

  async searchSubjects(input: SearchInput): Promise<Paged<SubjectListItem>> {
    const filter: Record<string, unknown> = {
      type: [2],
    };
    if (input.tags.length > 0) filter.tag = input.tags;
    if (input.metaTags.length > 0) filter.meta_tags = input.metaTags;
    if (input.airDates.length > 0) filter.air_date = input.airDates;
    if (input.ratings.length > 0) filter.rating = input.ratings;
    if (input.ranks.length > 0) filter.rank = input.ranks;
    if (input.includeNsfw) filter.nsfw = null;
    else filter.nsfw = false;

    const response = await this.fetchJson<SearchSubjectsResponse>(
      `/v0/search/subjects?limit=${input.limit}&offset=${input.offset}`,
      {
        method: "POST",
        body: JSON.stringify({
          keyword: input.q,
          sort: input.sort,
          filter,
        }),
      },
    );

    const total = response.total ?? response.data.length;
    const limit = response.limit ?? input.limit;
    const offset = response.offset ?? input.offset;
    return {
      total,
      limit,
      offset,
      hasMore: offset + limit < total && offset + limit <= 5000,
      data: response.data.map((subject) => this.mapSubjectListItem(subject)),
    };
  }

  async getSubject(subjectId: number): Promise<SubjectListItem> {
    const subject = await this.fetchJson<BangumiSubject>(
      `/v0/subjects/${subjectId}`,
    );
    return this.mapSubjectListItem(subject);
  }

  async getSubjectsByIds(
    subjectIds: number[],
    force = false,
    background?: (task: Promise<unknown>) => void,
  ): Promise<SubjectListItem[]> {
    const subjects = await mapLimit(subjectIds, 8, async (subjectId) => {
      try {
        return (await getOrSetJson(
          this.env,
          cacheKey(["subjects", subjectId, "brief"]),
          {
            ttlSeconds: (value: SubjectListItem) =>
              value.coverUrl ? 60 * 60 : 5 * 60,
            force,
          },
          () => this.getSubject(subjectId),
          background,
        )).value;
      } catch (error) {
        console.warn(`Schedule subject ${subjectId} unavailable`, error);
        return null;
      }
    });
    return subjects.filter(
      (subject): subject is SubjectListItem => subject != null,
    );
  }

  async getCalendar(): Promise<CalendarResponse> {
    return this.fetchJson<CalendarResponse>("/calendar", { auth: false });
  }

  async getCalendarSubjects(): Promise<SubjectListItem[]> {
    const calendar = await this.getCalendar();
    const bySubjectId = new Map<number, SubjectListItem>();
    for (const day of calendar) {
      for (const subject of day.items) {
        bySubjectId.set(subject.id, this.mapSubjectListItem(subject));
      }
    }
    return [...bySubjectId.values()];
  }

  mapSubjectListItem(subject: BangumiSubject): SubjectListItem {
    const tags =
      subject.tags
        ?.filter((tag) => tag.name)
        .map((tag) => ({ name: tag.name, count: tag.count })) ?? [];
    const metaTags = subject.meta_tags?.filter(Boolean) ?? [];
    return {
      subjectId: subject.id,
      name: subject.name,
      nameCn: subject.name_cn || undefined,
      displayName: pickDisplayName(subject.name, subject.name_cn),
      type: "anime",
      coverUrl: pickImage(subject.images),
      summary: subject.summary || subject.short_summary || undefined,
      shortSummary: subject.short_summary || undefined,
      airDate: subject.date || undefined,
      season: seasonFromDate(subject.date),
      platform: subject.platform || undefined,
      episodeTotal: positiveNumber(subject.total_episodes ?? subject.eps),
      nsfw: subject.nsfw,
      score: positiveNumber(subject.rating?.score),
      rank: positiveNumber(subject.rating?.rank),
      tags,
      metaTags,
      url: `${baseWeb(this.env)}/subject/${subject.id}`,
    };
  }

  private async fetchJson<T>(
    path: string,
    init?: RequestInit & { auth?: boolean },
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    headers.set("user-agent", userAgent(this.env));
    if (init?.method && init.method !== "GET")
      headers.set("content-type", "application/json");
    if (init?.auth !== false && this.env.BANGUMI_ACCESS_TOKEN) {
      headers.set("authorization", `Bearer ${this.env.BANGUMI_ACCESS_TOKEN}`);
    }

    let response: Response;
    try {
      response = await fetch(`${baseApi(this.env)}${path}`, {
        ...init,
        headers,
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const timeout = error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name);
      throw new HttpError(timeout ? 504 : 502, timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        error instanceof Error ? error.message : "Bangumi is unavailable.");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpError(
        response.status === 404 ? 404 : response.status === 429 ? 429 : 502,
        response.status === 404 ? "NOT_FOUND" : response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
        `Bangumi API ${response.status} ${path}: ${text.slice(0, 200)}`,
        undefined, response.headers.get("retry-after") ?? undefined,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      const timeout = error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name);
      throw new HttpError(timeout ? 504 : 502, timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        error instanceof Error ? error.message : "Invalid Bangumi response.");
    }
  }
}

export function subjectIdFromSites(
  sites: Array<{ site?: string; id?: string | number | null }>,
): number | undefined {
  const bgm = sites.find((site) => site.site === "bangumi" && site.id != null);
  return toInt(typeof bgm?.id === "string" ? Number(bgm.id) : bgm?.id);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
