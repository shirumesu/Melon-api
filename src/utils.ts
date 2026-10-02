import { HttpError, type ApiError, type Env, type SeasonInfo } from "./types";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set(
    "cache-control",
    headers.get("cache-control") ?? "public, max-age=60",
  );
  applyCorsHeaders(headers);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function preflightResponse(): Response {
  const headers = new Headers({ "cache-control": "public, max-age=600" });
  applyCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}

export function errorJson(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiError = { error: { code, message, details } };
  return json(body, { status, headers: { "cache-control": "no-store" } });
}

export function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_PARAMETER", `Expected an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function boolParam(value: string | null, fallback = false): boolean {
  if (value == null) return fallback;
  if (["1", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no"].includes(value)) return false;
  throw new HttpError(400, "INVALID_PARAMETER", "Expected a boolean parameter.");
}

export function dateParam(value: string | null, fallback = currentShanghaiDate()): string {
  if (value == null) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "INVALID_PARAMETER", "Expected a valid date in YYYY-MM-DD format.");
  }
  return value;
}

export function readListParam(url: URL, name: string): string[] {
  const inputs = [...url.searchParams.getAll(name), ...url.searchParams.getAll(`${name}s`)];
  const values = inputs.flatMap((value): string[] => {
    if (!value.trim().startsWith("[")) return value.split(",");
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed;
    } catch { /* Invalid arrays are rejected below. */ }
    throw new HttpError(400, "INVALID_PARAMETER", `${name} must contain strings.`);
  });
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return errorJson(
      503,
      "ADMIN_TOKEN_NOT_CONFIGURED",
      "ADMIN_TOKEN must be configured for admin operations.",
    );
  }
  const header = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (
    header?.startsWith(prefix) &&
    constantTimeEqual(header.slice(prefix.length), env.ADMIN_TOKEN)
  ) {
    return null;
  }
  return errorJson(401, "UNAUTHORIZED", "Missing or invalid admin token.");
}

export function applyCorsHeaders(headers: Headers): void {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type, if-none-match");
  headers.set("access-control-expose-headers", "ETag, X-Cache-Expires-At, X-Cache-Stale, Retry-After");
}

function constantTimeEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export function baseApi(env: Env): string {
  return trimTrailingSlash(env.BANGUMI_API_BASE ?? "https://api.bgm.tv");
}

export function baseWeb(env: Env): string {
  return trimTrailingSlash(env.BANGUMI_WEB_BASE ?? "https://bangumi.tv");
}

export function userAgent(env: Env): string {
  return env.BANGUMI_USER_AGENT ?? "melon-api/0.1";
}

export function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function compact<T extends Record<string, unknown>>(
  input: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  ) as Partial<T>;
}

export function pickDisplayName(name: string, nameCn?: string): string {
  return nameCn?.trim() || name;
}

export function pickImage(
  images?: {
    common?: string;
    medium?: string;
    large?: string;
    small?: string;
    grid?: string;
  } | null,
): string | undefined {
  return [images?.common, images?.medium, images?.large, images?.small, images?.grid]
    .find((value) => value != null && value.trim().length > 0);
}

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function toInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

export function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripTags(value: string): string {
  return htmlDecode(value).replace(/\s+/g, " ").trim();
}

export function currentShanghaiDate(): string {
  return shanghaiDateString(new Date());
}

export function shanghaiDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function formatInShanghai(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}`;
}

export function weekdayInShanghai(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(date);
}

export function seasonFromDate(dateString?: string): SeasonInfo | undefined {
  if (!dateString) return undefined;
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateString);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return undefined;
  const quarter = (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const names = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
  const name = names[quarter - 1] ?? "WINTER";
  return {
    year,
    quarter,
    code: `${year}Q${quarter}`,
    label: `${year} ${name}`,
    name,
  };
}

export function currentSeason(date = new Date()): SeasonInfo {
  return seasonFromDate(shanghaiDateString(date))!;
}

export function seasonDateRange(season: SeasonInfo): {
  start: string;
  end: string;
} {
  const startMonth = (season.quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const endDate = new Date(Date.UTC(season.year, endMonth, 0));
  return {
    start: `${season.year}-${String(startMonth).padStart(2, "0")}-01`,
    end: `${season.year}-${String(endMonth).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`,
  };
}

export function parseSeason(value: string | null): SeasonInfo {
  if (!value || value.toLowerCase() === "current") return currentSeason();
  const normalized = value.trim().toUpperCase().replace(/^(\d{4})-/, "$1 ");
  const match = /^(\d{4})Q([1-4])$/.exec(normalized);
  if (match) {
    const year = Number(match[1]);
    const quarter = Number(match[2]) as 1 | 2 | 3 | 4;
    const names = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
    const name = names[quarter - 1] ?? "WINTER";
    return {
      year,
      quarter,
      code: `${year}Q${quarter}`,
      label: `${year} ${name}`,
      name,
    };
  }
  const labelMatch = /^(\d{4})\s*(WINTER|SPRING|SUMMER|FALL)$/.exec(normalized);
  if (labelMatch) {
    const year = Number(labelMatch[1]);
    const names = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
    const quarter = (names.indexOf(labelMatch[2] as SeasonInfo["name"]) + 1) as
      | 1
      | 2
      | 3
      | 4;
    return {
      year,
      quarter,
      code: `${year}Q${quarter}`,
      label: `${year} ${labelMatch[2]}`,
      name: labelMatch[2] as SeasonInfo["name"],
    };
  }
  throw new HttpError(400, "INVALID_PARAMETER", "Expected a season such as 2026Q3 or 2026-summer.");
}
