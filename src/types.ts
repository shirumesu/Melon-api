export type Env = {
  CACHE_BUCKET?: R2Bucket;
  DB?: D1Database;
  BANGUMI_ACCESS_TOKEN?: string;
  ADMIN_TOKEN?: string;
  BANGUMI_API_BASE?: string;
  BANGUMI_WEB_BASE?: string;
  BANGUMI_DATA_SOURCE?: string;
  BANGUMI_USER_AGENT?: string;
};

export type CachePolicy = {
  ttlSeconds: number;
  force?: boolean;
};

export type Paged<T> = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  data: T[];
};

export type SubjectCollectionStats = {
  wish: number;
  watching: number;
  completed: number;
  on_hold: number;
  dropped: number;
};

export type SubjectTag = {
  name: string;
  count?: number;
};

export type SubjectInfoBoxItem = {
  key: string;
  value: string;
};

export type ImageSet = {
  small?: string;
  grid?: string;
  common?: string;
  medium?: string;
  large?: string;
};

export type SubjectListItem = {
  subjectId: number;
  name: string;
  nameCn?: string;
  displayName: string;
  type: "anime";
  coverUrl?: string;
  summary?: string;
  shortSummary?: string;
  airDate?: string;
  season?: SeasonInfo;
  platform?: string;
  episodeTotal?: number;
  score?: number;
  rank?: number;
  tags: SubjectTag[];
  metaTags: string[];
  url: string;
};

export type SubjectDetail = SubjectListItem & {
  ratingCount?: number;
  rating?: {
    score?: number;
    rank?: number;
    total?: number;
    count?: Record<string, number>;
  };
  collectionStats?: SubjectCollectionStats;
  infoBox: SubjectInfoBoxItem[];
  episodes: Episode[];
  characters: CharacterCredit[];
  staff: StaffCredit[];
  relatedSubjects: RelatedSubject[];
  comments: SubjectComment[];
  topics: Topic[];
  schedule?: SubjectSchedule;
  source: SourceInfo;
};

export type Episode = {
  episodeId: number;
  subjectId: number;
  type: "main" | "special" | "op" | "ed" | "trailer" | "mad" | "other";
  sort: number;
  ep?: number;
  name: string;
  nameCn?: string;
  displayName: string;
  airdate?: string;
  duration?: string;
  desc?: string;
  commentCount?: number;
  url: string;
};

export type CharacterCredit = {
  characterId: number;
  name: string;
  nameCn?: string;
  displayName: string;
  role?: string;
  imageUrl?: string;
  actors: PersonCredit[];
  url: string;
};

export type PersonCredit = {
  personId: number;
  name: string;
  nameCn?: string;
  displayName: string;
  imageUrl?: string;
  relation?: string;
  career?: string[];
  url: string;
};

export type StaffCredit = PersonCredit & {
  role?: string;
};

export type RelatedSubject = {
  subjectId: number;
  name: string;
  nameCn?: string;
  displayName: string;
  relation?: string;
  coverUrl?: string;
  url: string;
};

export type SubjectComment = {
  id?: string;
  user: {
    username?: string;
    nickname: string;
    avatarUrl?: string;
  };
  score?: number;
  status?: string;
  createdAt?: string;
  text: string;
  url?: string;
};

export type Topic = {
  topicId?: number;
  title: string;
  author?: string;
  replies?: number;
  updatedAt?: string;
  url?: string;
};

export type EpisodeComment = {
  floor?: number;
  user: {
    username?: string;
    nickname: string;
    avatarUrl?: string;
  };
  createdAt?: string;
  text: string;
  url?: string;
};

export type SubjectSchedule = {
  firstAiringAt?: string;
  firstAiringAtShanghai?: string;
  weekday?: string;
  recurrence?: "P0D" | "P1D" | "P7D" | "P1M";
  nextAiringAt?: string;
  nextAiringAtShanghai?: string;
  source: "bangumi-data" | "bangumi-date" | "unknown";
};

export type ScheduleOccurrence = {
  airingAt: string;
  airingAtShanghai: string;
  weekday: string;
  subjectId?: number;
  name: string;
  nameCn?: string;
  displayName: string;
  type: string;
  coverUrl?: string;
  episodeTotal?: number;
  sites: Array<{
    site: string;
    id?: string | number | null;
    url?: string | null;
  }>;
  source: {
    ruleKind: "broadcast" | "begin-weekly-fallback";
    broadcast?: string;
    begin?: string;
    end?: string;
  };
};

export type ScheduleResponse = {
  generatedAt: string;
  centerDate: string;
  days: number;
  window: {
    start: string;
    endExclusive: string;
  };
  items: ScheduleOccurrence[];
  byDate: Record<string, ScheduleOccurrence[]>;
};

export type SeasonInfo = {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  code: string;
  label: string;
  name: "WINTER" | "SPRING" | "SUMMER" | "FALL";
};

export type SourceInfo = {
  provider: "bangumi";
  subjectUrl?: string;
  apiCoverage: {
    subject: boolean;
    episodes: boolean;
    characters: boolean;
    staff: boolean;
    relatedSubjects: boolean;
    comments: boolean;
    topics: boolean;
  };
  notes: string[];
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}
