import { HttpError, type Env } from "./types";
import { json } from "./utils";

const BANGUMI_TOKEN_URL = "https://bgm.tv/oauth/access_token";
const GRANT_FIELDS: Record<string, string[]> = {
  authorization_code: ["code", "redirect_uri", "state"],
  refresh_token: ["refresh_token", "redirect_uri"],
};

/**
 * Completes Bangumi's token request with the application secret, which cannot
 * ship inside a desktop binary. Stateless: tokens pass through and are never
 * stored, cached or logged.
 */
export async function bangumiToken(request: Request, env: Env): Promise<Response> {
  const secret = env.BANGUMI_OAUTH_CLIENT_SECRET;
  if (!secret) throw new HttpError(503, "NOT_CONFIGURED", "Bangumi sign-in is not configured.");
  const body = (await request.json()) as Record<string, unknown>;
  const fields = GRANT_FIELDS[String(body.grant_type)];
  if (!fields || typeof body.client_id !== "string" || !body.client_id) {
    throw new HttpError(400, "INVALID_PARAMETER", "Expected client_id and an authorization_code or refresh_token grant.");
  }
  const form = new URLSearchParams({
    grant_type: String(body.grant_type),
    client_id: body.client_id,
    client_secret: secret,
  });
  for (const field of fields) {
    if (typeof body[field] === "string") form.set(field, body[field] as string);
  }
  const upstream = await fetch(BANGUMI_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "user-agent": env.BANGUMI_USER_AGENT ?? "melon-api",
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  return json(await upstream.json(), {
    status: upstream.status,
    headers: { "cache-control": "no-store" },
  });
}
