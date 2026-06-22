import type {
  CharacterCredit,
  Env,
  Episode,
  ImageSet,
  Paged,
  PersonCredit,
  RelatedSubject,
  StaffCredit,
  SubjectCollectionStats,
  SubjectDetail,
  SubjectInfoBoxItem,
  SubjectListItem,
  SubjectTag
} from "./types";
import {
  baseApi,
  baseWeb,
  pickDisplayName,
  pickImage,
  positiveNumber,
  seasonFromDate,
  stripTags,
  toInt,
  userAgent
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
  infobox?: InfoboxResponseItem[];
};

type InfoboxResponseItem = {
  key: string;
  value:
    | string
    | Array<
        | {
            k?: string;
            v: string;
          }
        | {
            v: string;
          }
      >;
};

type EpisodesResponse = {
  total?: number;
  limit?: number;
  offset?: number;
  data: BangumiEpisode[];
};

type BangumiEpisode = {
  id: number;
  subject_id?: number;
  type: number;
  sort: number;
  ep?: number;
  name: string;
  name_cn?: string;
  airdate?: string;
  duration?: string;
  desc?: string;
  comment?: number;
};

type RelatedCharacterResponse = {
  id: number;
  name: string;
  type?: number;
  relation?: string;
  images?: ImageSet | null;
  actors?: Array<{
    id: number;
    name: string;
    type?: number;
    career?: string[];
    images?: ImageSet | null;
    relation?: string;
  }>;
};

type RelatedPersonResponse = {
  id: number;
  name: string;
  type?: number;
  career?: string[];
  images?: ImageSet | null;
  relation?: string;
};

type RelatedSubjectResponse = {
  id: number;
  name: string;
  name_cn?: string;
  images?: ImageSet | null;
  relation?: string;
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
  constructor(private readonly env: Env) {}

  async searchSubjects(input: SearchInput): Promise<Paged<SubjectListItem>> {
    const filter: Record<string, unknown> = {
      type: [2]
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
          filter
        })
      }
    );

    const total = response.total ?? response.data.length;
    const limit = response.limit ?? input.limit;
    const offset = response.offset ?? input.offset;
    return {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      data: response.data.map((subject) => this.mapSubjectListItem(subject))
    };
  }

  async getSubject(subjectId: number): Promise<SubjectListItem> {
    const subject = await this.fetchJson<BangumiSubject>(`/v0/subjects/${subjectId}`);
    return this.mapSubjectListItem(subject);
  }

  async getSubjectRaw(subjectId: number): Promise<BangumiSubject> {
    return this.fetchJson<BangumiSubject>(`/v0/subjects/${subjectId}`);
  }

  async getEpisodes(subjectId: number): Promise<Episode[]> {
    const response = await this.fetchJson<EpisodesResponse>(
      `/v0/episodes?subject_id=${subjectId}&type=0&limit=200&offset=0`
    );
    return response.data
      .filter((episode) => episode.id > 0 && episode.type === 0)
      .map((episode) => this.mapEpisode(episode, subjectId));
  }

  async getEpisode(episodeId: number): Promise<Episode> {
    const episode = await this.fetchJson<BangumiEpisode>(`/v0/episodes/${episodeId}`);
    return this.mapEpisode(episode, episode.subject_id ?? 0);
  }

  async getCharacters(subjectId: number): Promise<CharacterCredit[]> {
    const response = await this.fetchJson<RelatedCharacterResponse[]>(
      `/v0/subjects/${subjectId}/characters`
    );
    return response.map((character) => ({
      characterId: character.id,
      name: character.name,
      displayName: character.name,
      role: character.relation,
      imageUrl: pickImage(character.images),
      actors: (character.actors ?? []).map((actor) => this.mapPerson(actor, actor.relation)),
      url: `${baseWeb(this.env)}/character/${character.id}`
    }));
  }

  async getPersons(subjectId: number): Promise<StaffCredit[]> {
    const response = await this.fetchJson<RelatedPersonResponse[]>(`/v0/subjects/${subjectId}/persons`);
    return response.map((person) => ({
      ...this.mapPerson(person, person.relation),
      role: person.relation
    }));
  }

  async getRelatedSubjects(subjectId: number): Promise<RelatedSubject[]> {
    const response = await this.fetchJson<RelatedSubjectResponse[]>(`/v0/subjects/${subjectId}/subjects`);
    return response.map((subject) => ({
      subjectId: subject.id,
      name: subject.name,
      nameCn: subject.name_cn || undefined,
      displayName: pickDisplayName(subject.name, subject.name_cn),
      relation: subject.relation,
      coverUrl: pickImage(subject.images),
      url: `${baseWeb(this.env)}/subject/${subject.id}`
    }));
  }

  async getCalendar(): Promise<CalendarResponse> {
    return this.fetchJson<CalendarResponse>("/calendar", { auth: false });
  }

  mapSubjectDetail(
    subject: BangumiSubject,
    parts: {
      episodes: Episode[];
      characters: CharacterCredit[];
      staff: StaffCredit[];
      relatedSubjects: RelatedSubject[];
      comments: SubjectDetail["comments"];
      topics: SubjectDetail["topics"];
      notes: string[];
    }
  ): SubjectDetail {
    const listItem = this.mapSubjectListItem(subject);
    return {
      ...listItem,
      ratingCount: positiveNumber(subject.rating?.total),
      rating: {
        score: positiveNumber(subject.rating?.score),
        rank: positiveNumber(subject.rating?.rank),
        total: positiveNumber(subject.rating?.total),
        count: subject.rating?.count
      },
      collectionStats: mapSubjectCollectionStats(subject.collection),
      infoBox: mapInfobox(subject.infobox),
      episodes: parts.episodes,
      characters: parts.characters,
      staff: parts.staff,
      relatedSubjects: parts.relatedSubjects,
      comments: parts.comments,
      topics: parts.topics,
      source: {
        provider: "bangumi",
        subjectUrl: `${baseWeb(this.env)}/subject/${subject.id}`,
        apiCoverage: {
          subject: true,
          episodes: parts.episodes.length > 0,
          characters: parts.characters.length > 0,
          staff: parts.staff.length > 0,
          relatedSubjects: parts.relatedSubjects.length > 0,
          comments: parts.comments.length > 0,
          topics: parts.topics.length > 0
        },
        notes: parts.notes
      }
    };
  }

  mapSubjectListItem(subject: BangumiSubject): SubjectListItem {
    const tags = subject.tags?.filter((tag) => tag.name).map((tag) => ({ name: tag.name, count: tag.count })) ?? [];
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
      score: positiveNumber(subject.rating?.score),
      rank: positiveNumber(subject.rating?.rank),
      tags,
      metaTags,
      url: `${baseWeb(this.env)}/subject/${subject.id}`
    };
  }

  mapEpisode(episode: BangumiEpisode, fallbackSubjectId: number): Episode {
    const sort = typeof episode.ep === "number" && episode.ep > 0 ? episode.ep : episode.sort;
    return {
      episodeId: episode.id,
      subjectId: episode.subject_id ?? fallbackSubjectId,
      type: mapEpisodeType(episode.type),
      sort,
      ep: episode.ep,
      name: episode.name,
      nameCn: episode.name_cn || undefined,
      displayName: pickDisplayName(episode.name, episode.name_cn),
      airdate: episode.airdate || undefined,
      duration: episode.duration || undefined,
      desc: episode.desc ? stripTags(episode.desc) : undefined,
      commentCount: positiveNumber(episode.comment),
      url: `${baseWeb(this.env)}/ep/${episode.id}`
    };
  }

  private mapPerson(person: RelatedPersonResponse, relation?: string): PersonCredit {
    return {
      personId: person.id,
      name: person.name,
      displayName: person.name,
      imageUrl: pickImage(person.images),
      relation,
      career: person.career,
      url: `${baseWeb(this.env)}/person/${person.id}`
    };
  }

  private async fetchJson<T>(
    path: string,
    init?: RequestInit & { auth?: boolean }
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    headers.set("user-agent", userAgent(this.env));
    if (init?.method && init.method !== "GET") headers.set("content-type", "application/json");
    if (init?.auth !== false && this.env.BANGUMI_ACCESS_TOKEN) {
      headers.set("authorization", `Bearer ${this.env.BANGUMI_ACCESS_TOKEN}`);
    }

    const response = await fetch(`${baseApi(this.env)}${path}`, {
      ...init,
      headers
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Bangumi API ${response.status} ${path}: ${text.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }
}

export function mapSubjectCollectionStats(
  collection: BangumiSubject["collection"]
): SubjectCollectionStats | undefined {
  if (!collection) return undefined;
  return {
    wish: collection.wish ?? 0,
    watching: collection.doing ?? 0,
    completed: collection.collect ?? 0,
    on_hold: collection.on_hold ?? 0,
    dropped: collection.dropped ?? 0
  };
}

export function mapInfobox(infobox: BangumiSubject["infobox"]): SubjectInfoBoxItem[] {
  if (!infobox?.length) return [];
  return infobox.flatMap((item) => {
    const value = infoboxValueToString(item.value);
    return value ? [{ key: item.key, value }] : [];
  });
}

function infoboxValueToString(value: InfoboxResponseItem["value"]): string {
  if (typeof value === "string") return value.trim();
  return value
    .map((entry) => ("k" in entry && entry.k ? `${entry.k}: ${entry.v}` : entry.v))
    .filter(Boolean)
    .join(" / ");
}

function mapEpisodeType(value: number): Episode["type"] {
  switch (value) {
    case 0:
      return "main";
    case 1:
      return "special";
    case 2:
      return "op";
    case 3:
      return "ed";
    case 4:
      return "trailer";
    case 5:
      return "mad";
    default:
      return "other";
  }
}

export function subjectIdFromSites(sites: Array<{ site?: string; id?: string | number | null }>): number | undefined {
  const bgm = sites.find((site) => site.site === "bangumi" && site.id != null);
  return toInt(typeof bgm?.id === "string" ? Number(bgm.id) : bgm?.id);
}
