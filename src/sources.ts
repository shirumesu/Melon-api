import snapshot from "./source-rules.json";
import { applyCorsHeaders } from "./utils";

export async function sourceRules(request: Request, url: URL): Promise<Response> {
  const engine = Math.max(0, Number.parseInt(url.searchParams.get("engine") ?? "1", 10) || 0);
  const payload = JSON.stringify({
    ...snapshot,
    clientEngine: engine,
    requiresUpdate: snapshot.rules.filter((rule) => rule.minEngine > engine).map((rule) => rule.id),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const etag = `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300, must-revalidate",
    "etag": etag,
  });
  applyCorsHeaders(headers);
  headers.set("access-control-expose-headers", "ETag");
  if (request.headers.get("if-none-match")?.split(",").map((value) => value.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(payload, { headers });
}
