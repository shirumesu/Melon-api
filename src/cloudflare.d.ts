interface R2Object {
  key: string;
  etag: string;
  size: number;
  customMetadata?: Record<string, string>;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  json<T = unknown>(): Promise<T>;
}

/** A conditional read or write: [etagMatches] for compare-and-swap. */
interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  /** Without the body when [onlyIf] fails. */
  get(key: string, options: { onlyIf: R2Conditional }): Promise<R2ObjectBody | R2Object | null>;
  /** Null when [onlyIf] fails. */
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: R2Conditional;
    },
  ): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: {
    cursor?: string;
    include?: Array<"httpMetadata" | "customMetadata">;
    limit?: number;
    prefix?: string;
  }): Promise<R2Objects>;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { last_row_id?: number; changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface CacheStorage {
  default: Cache;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
  type: "scheduled";
}
