import { bangumiUser } from "./bangumi_user";
import { HttpError, type Env } from "./types";
import { json } from "./utils";

/**
 * MelonBanG settings sync: one JSON object of settings per Bangumi user,
 * kept with a revision number. The client merges; the server only stores
 * the latest object and refuses a write made against an older revision
 * (If-Match), returning the current one so the client can merge again.
 * Clients never send credentials or machine-specific paths here.
 */

/** Largest stored settings object, in bytes of JSON. */
export const MAX_SETTINGS_BYTES = 256 * 1024;

type Row = { rev: number; body: string; updated: number };

export type SyncedSettings = { rev: number; updated: string | null; data: Record<string, unknown> };

function database(env: Env): D1Database {
  if (!env.DB) throw new HttpError(503, "NOT_CONFIGURED", "Sync storage is not configured.");
  return env.DB;
}

async function current(db: D1Database, user: number): Promise<SyncedSettings> {
  const row = await db
    .prepare("SELECT rev, body, updated FROM settings_sync WHERE user = ?")
    .bind(user)
    .first<Row>();
  if (!row) return { rev: 0, updated: null, data: {} };
  return { rev: row.rev, updated: new Date(row.updated).toISOString(), data: JSON.parse(row.body) };
}

function respond(value: SyncedSettings, status = 200): Response {
  return json(value, {
    status,
    headers: { "cache-control": "private, no-store", etag: `"${value.rev}"` },
  });
}

/** The signed-in user's settings; revision 0 and no data before the first upload. */
export async function getSettings(request: Request, env: Env): Promise<Response> {
  const user = await bangumiUser(request, env);
  return respond(await current(database(env), user));
}

/**
 * Replaces the user's settings when `If-Match` names the stored revision
 * (`"0"` before the first upload); otherwise 412 with the stored object.
 */
export async function putSettings(request: Request, env: Env): Promise<Response> {
  const match = /^"?(\d+)"?$/.exec(request.headers.get("if-match")?.trim() ?? "")?.[1];
  if (match == null) {
    throw new HttpError(428, "PRECONDITION_REQUIRED", "Writes need If-Match with the revision they were based on.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BYTES + 64) {
    throw new HttpError(413, "TOO_LARGE", `Settings must be at most ${MAX_SETTINGS_BYTES} bytes.`);
  }
  let data: unknown;
  try {
    data = (JSON.parse(text) as { data?: unknown }).data;
  } catch {
    throw new HttpError(400, "INVALID_PARAMETER", "Body must be JSON.");
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "INVALID_PARAMETER", "Body must be {\"data\": {...}}.");
  }
  const body = JSON.stringify(data);
  if (new TextEncoder().encode(body).length > MAX_SETTINGS_BYTES) {
    throw new HttpError(413, "TOO_LARGE", `Settings must be at most ${MAX_SETTINGS_BYTES} bytes.`);
  }
  const user = await bangumiUser(request, env);
  const db = database(env);
  const base = Number(match);
  const now = Date.now();
  const result = base === 0
    ? await db
        .prepare("INSERT INTO settings_sync (user, rev, body, updated) VALUES (?, 1, ?, ?) ON CONFLICT(user) DO NOTHING")
        .bind(user, body, now)
        .run()
    : await db
        .prepare("UPDATE settings_sync SET rev = rev + 1, body = ?, updated = ? WHERE user = ? AND rev = ?")
        .bind(body, now, user, base)
        .run();
  if (result.meta.changes === 0) {
    const stored = await current(db, user);
    throw new HttpError(412, "REVISION_MISMATCH", "云端设置已被其他设备更新", stored);
  }
  return respond({ rev: base + 1, updated: new Date(now).toISOString(), data: data as Record<string, unknown> });
}

/** Removes the user's stored settings. */
export async function deleteSettings(request: Request, env: Env): Promise<Response> {
  const user = await bangumiUser(request, env);
  await database(env).prepare("DELETE FROM settings_sync WHERE user = ?").bind(user).run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
