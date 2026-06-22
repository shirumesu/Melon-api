interface R2ObjectBody {
  key: string;
  customMetadata?: Record<string, string>;
  json<T = unknown>(): Promise<T>;
}

interface R2Object {
  key: string;
  customMetadata?: Record<string, string>;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void>;
  delete(key: string | string[]): Promise<void>;
  list(options?: {
    cursor?: string;
    include?: Array<"httpMetadata" | "customMetadata">;
    limit?: number;
    prefix?: string;
  }): Promise<R2Objects>;
}

interface D1Database {
  prepare(query: string): unknown;
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
