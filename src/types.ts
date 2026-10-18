export type Env = {
  CACHE_BUCKET?: R2Bucket;
  DB?: D1Database;
  BANGUMI_ACCESS_TOKEN?: string;
  ADMIN_TOKEN?: string;
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
  tags: SubjectTag[];
  metaTags: string[];
  url: string;
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
