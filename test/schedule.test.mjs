import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { writeJson } from "../src/cache.ts";
import worker from "../src/index.ts";

const env = { BANGUMI_API_BASE: "https://api.schedule.test", BANGUMI_DATA_SOURCE: "https://data.schedule.test/rules.json" };
const context = { waitUntil() { assert.fail("Fresh schedule should not start background refresh"); } };
function subject(id, name, cover = true) {
  return { id, name, name_cn: name, images: cover ? { common: `https://images.test/${id}.jpg` } : undefined, total_episodes: 742, nsfw: false };
}
function entry(id) {
  return { title: `Title ${id}`, type: "tv", begin: "2025-01-01T00:00:00Z", broadcast: "R/2025-01-01T00:00:00Z/P1D", sites: [{ site: "bangumi", id }] };
}

test("one unavailable subject does not discard other timetable covers and successful summaries are reused", async (t) => {
  const requested = [];
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    requested.push(url.pathname);
    if (url.pathname === "/rules.json") return Response.json({ items: [entry(212153), entry(541423), entry(999)] });
    if (url.pathname === "/calendar") return Response.json([{ items: [subject(541423, "Existing calendar title")] }]);
    if (url.pathname === "/v0/search/subjects") return Response.json({ data: [] });
    if (url.pathname === "/v0/subjects/212153") return Response.json(subject(212153, "巧虎 WAO！"));
    if (url.pathname === "/v0/subjects/999") return new Response("Not found", { status: 404 });
    assert.fail(`Unexpected lookup: ${url.pathname}`);
  });
  async function schedule(date, force = false) {
    const response = await worker.fetch(new Request(`https://melon.test/v1/schedule/latest?days=0&date=${date}${force ? "&force=1" : ""}`, { headers: { authorization: "Bearer test-admin" } }), { ...env, ADMIN_TOKEN: "test-admin" }, context);
    assert.equal(response.status, 200);
    return response.json();
  }
  const first = await schedule("2026-01-15");
  const recovered = first.items.find((item) => item.subjectId === 212153);
  assert.equal(recovered.coverUrl, "https://images.test/212153.jpg");
  assert.equal(recovered.episodeTotal, 742);
  assert.equal(recovered.needsFallback.cover, false);
  assert.equal(first.items.find((item) => item.subjectId === 999).needsFallback.cover, true);
  assert.equal(requested.includes("/v0/subjects/541423"), false, "Complete calendar metadata needs no individual lookup");
  assert.equal(first.cache.key, "schedule-v2/2026-01-15/0/false");
  requested.length = 0;
  const nextDay = await schedule("2026-01-16");
  assert.equal(nextDay.items.find((item) => item.subjectId === 212153).coverUrl, recovered.coverUrl);
  assert.deepEqual(requested, ["/v0/subjects/999"], "Changing date reuses source rules, calendar, season and successful precise covers");
  requested.length = 0;
  await schedule("2026-01-16", true);
  assert.deepEqual(requested.sort(), ["/rules.json", "/calendar", "/v0/search/subjects", "/v0/subjects/212153", "/v0/subjects/999"].sort(), "Admin force refresh reaches source caches too");
});

test("calendar route forwards background refresh and returns expired schedule immediately", async (t) => {
  const date = "2026-01-17";
  const saved = { generatedAt: "2026-01-17T00:00:00Z", centerDate: date, days: 0, items: [{ subjectId: 97777, displayName: "Saved title" }], byDate: {} };
  await writeJson({}, `schedule-v2/${date}/0/false`, {
    value: saved,
    cachedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const gate = Promise.withResolvers();
  const tasks = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/background-rules.json") return Response.json({ items: [entry(97777)] });
    if (url.pathname === "/calendar") return Response.json([]);
    if (url.pathname === "/v0/search/subjects") return Response.json({ data: [] });
    assert.equal(url.pathname, "/v0/subjects/97777");
    await gate.promise;
    return Response.json(subject(97777, "Fresh title"));
  });
  let completed = false;
  const response = worker.fetch(
    new Request(`https://melon.test/v1/schedule/latest?days=0&date=${date}`),
    { ...env, BANGUMI_DATA_SOURCE: "https://data.schedule.test/background-rules.json" },
    { waitUntil(task) { tasks.push(task); } },
  ).then((response) => { completed = true; return response; });
  try {
    await setImmediate();
    assert.equal(completed, true, "Calendar must return stale data without waiting on enrichment");
    const body = await (await response).json();
    assert.equal(body.items[0].displayName, "Saved title");
    assert.equal(body.cache.stale, true);
  } finally {
    gate.resolve();
    await Promise.all(tasks);
  }
});
