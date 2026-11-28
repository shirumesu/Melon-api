export type Env = {
  CACHE_BUCKET?: R2Bucket;
  DB?: D1Database;
  BANGUMI_ACCESS_TOKEN?: string;
  ADMIN_TOKEN?: string;
  BANGUMI_OAUTH_CLIENT_SECRET?: string;
  BANGUMI_API_BASE?: string;
  BANGUMI_WEB_BASE?: string;
  BANGUMI_DATA_SOURCE?: string;
  BANGUMI_USER_AGENT?: string;
  PUBLIC_BASE_URL?: string;
};

export type CachePolicy<T = unknown> = {
  ttlSeconds: number | ((value: T) => number);
  canServeStale?: (value: T) => boolean;
  force?: boolean;
  staleWhileRevalidateSeconds?: number;
  maxStaleSeconds?: number;
  /** Refreshes an entry that expires within this many seconds, as the cron does before the next run. */
  refreshAheadSeconds?: number;
};

export type Paged<T> = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  data: T[];
};

export type SubjectTag = {
  name: string;
  count?: number;
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
  nsfw?: boolean;
  score?: number;
  rank?: number;
  ratingCount?: number;
  collectionStats?: CollectionStats;
  tags: SubjectTag[];
  metaTags: string[];
  url: string;
};

/** Bangumi users with the subject in each collection list. */
export type CollectionStats = {
  wish: number;
  watching: number;
  completed: number;
  on_hold: number;
  dropped: number;
};

/** A main episode with a full air date. */
export type EpisodeBrief = {
  id: number;
  sort: number;
  ep?: number;
  airdate: string;
  comments: number;
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
  summary?: string;
  airDate?: string;
  platform?: string;
  score?: number;
  rank?: number;
  ratingCount?: number;
  collectionStats?: CollectionStats;
  /** The main episode this broadcast airs, matched by air date. */
  episode?: EpisodeBrief & { final: boolean };
  /** Without an episode that day but with ones before and after: when the next airs. */
  breakUntil?: string;
  /** The show's heat in the response's heat week, 0 to 100, and the week before's. */
  heat?: number;
  previousHeat?: number;
  /** The episode comments the heat counted. */
  heatComments?: number;
  /** Collections the subject gained in the response's heat week, and the week before. */
  collectionGain?: number;
  previousCollectionGain?: number;
  tags: SubjectTag[];
  metaTags: string[];
  nsfw?: boolean;
  nsfwStatus: "safe" | "nsfw" | "unknown";
  hasSubjectId: boolean;
  detailAvailable: boolean;
  needsFallback: {
    cover: boolean;
    episodeTotal: boolean;
    nsfw: boolean;
  };
  url?: string;
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
  startDate?: string;
  dayCount?: number;
  window: {
    start: string;
    endExclusive: string;
  };
  items: ScheduleOccurrence[];
  byDate?: Record<string, ScheduleOccurrence[]>;
  /** Subjects in the window whose details or episodes are still being fetched. */
  incomplete: number;
  /** The Monday-start week heat covers, and since when collections were counted. */
  heat?: { week: string; since?: string };
};

export type SeasonInfo = {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  code: string;
  label: string;
  name: "WINTER" | "SPRING" | "SUMMER" | "FALL";
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
    readonly details?: unknown,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}
