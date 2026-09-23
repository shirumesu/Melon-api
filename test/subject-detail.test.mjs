import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import worker from "../src/index.ts";
import { BangumiClient } from "../src/bangumi.ts";
import { cacheKey, writeJson } from "../src/cache.ts";

const env = {
  BANGUMI_API_BASE: "https://api.example.test",
  BANGUMI_WEB_BASE: "https://web.example.test",
  BANGUMI_DATA_SOURCE: "https://data.example.test/schedule.json",
};
const context = {
  waitUntil() {
    assert.fail("Subject reads must not schedule background jobs");
  },
};

function readSubject(id, query = "") {
  return worker.fetch(
    new Request(`https://melon.example.test/v1/subjects/${id}${query}`),
    env,
    context,
  );
}

function rawSubject(id) {
  return {
    id,
    name: "Test subject",
    name_cn: "测试番剧",
    summary: "A cached synopsis",
    date: "2026-01-01",
    eps: 12,
    rating: { score: 8.1, rank: 42, total: 100 },
  };
}

async function seedDetail(id) {
  const detail = new BangumiClient(env).mapSubjectDetail(rawSubject(id), {
    episodes: [{ episodeId: 11, displayName: "第一话" }],
    characters: [{ characterId: 21, displayName: "角色" }],
    staff: [{ personId: 31, displayName: "制作人员" }],
    relatedSubjects: [{ subjectId: 41, displayName: "关联作品" }],
    comments: [],
    topics: [],
    notes: [],
  });
  detail.schedule = { weekday: 4, source: "air-date" };
  await writeJson(env, cacheKey(["subjects", id, "full-v3"]), {
    value: detail,
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return JSON.parse(JSON.stringify(detail));
}

test("cached includeHtml=false returns complete structured data without upstream requests", async (t) => {
  const id = 90001;
  const expected = await seedDetail(id);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    requests.push(String(input));
    throw new Error("No upstream request expected for cached structured data");
  });

  for (const value of ["false", "0"]) {
    const response = await readSubject(id, `?includeHtml=${value}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    const body = await response.json();
    assert.equal(body.cache.hit, true);
    assert.equal(body.cache.key, `subjects/${id}/full-v3`);
    assert.deepEqual(body.data, expected);
  }
  assert.deepEqual(requests, []);
});

test("default detail still loads live HTML without contaminating the structured cache", async (t) => {
  const id = 90002;
  const expected = await seedDetail(id);
  const paths = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, env.BANGUMI_WEB_BASE);
    paths.push(url.pathname);
    if (url.pathname.endsWith("/comments")) {
      return new Response(`
        <div id="comment_box">
          <div class="item clearit" data-item-user="reader">
            <a href="/user/reader" class="l">Reader</a>
            <p class="comment">A live comment</p>
          </div>
        </div>`);
    }
    assert.equal(url.pathname, `/subject/${id}/board`);
    return new Response(`
      <table><tr>
        <td><a href="/subject/topic/700">A live topic</a></td>
        <td><a href="/user/reader">Reader</a></td>
      </tr></table>`);
  });

  for (const query of ["", "?includeHtml=true"]) {
    const response = await readSubject(id, query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.cache.hit, true);
    assert.equal(body.data.comments[0].text, "A live comment");
    assert.equal(body.data.topics[0].title, "A live topic");
    assert.equal(body.data.source.apiCoverage.comments, true);
    assert.equal(body.data.source.apiCoverage.topics, true);
  }
  assert.deepEqual(paths.sort(), [
    `/subject/${id}/board`,
    `/subject/${id}/board`,
    `/subject/${id}/comments`,
    `/subject/${id}/comments`,
  ]);
  paths.length = 0;
  const structured = await readSubject(id, "?includeHtml=false");
  assert.deepEqual((await structured.json()).data, expected);
  assert.deepEqual(paths, []);
});

test("full=false keeps the brief route even when HTML is explicitly requested", async (t) => {
  const id = 90003;
  const paths = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    paths.push(url.pathname);
    assert.equal(url.origin, env.BANGUMI_API_BASE);
    assert.equal(url.pathname, `/v0/subjects/${id}`);
    return Response.json(rawSubject(id));
  });

  const response = await readSubject(id, "?full=false&includeHtml=true");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  const body = await response.json();
  assert.equal(body.cache.key, `subjects/${id}/brief`);
  assert.equal(body.data.subjectId, id);
  assert.equal(body.data.displayName, "测试番剧");
  assert.equal(body.data.episodes, undefined);
  assert.equal(body.data.comments, undefined);
  assert.deepEqual(paths, [`/v0/subjects/${id}`]);
});

test("cold structured detail starts enrichment before the subject response completes", async (t) => {
  const id = 90004;
  const subjectGate = Promise.withResolvers();
  const paths = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    paths.push(url.pathname);
    if (url.origin === new URL(env.BANGUMI_DATA_SOURCE).origin) {
      return Response.json({ items: [
        { title: "Original", titleTranslate: { "zh-Hans": ["微速前行 第二季"], "zh-Hant": ["微速前進！2！！", "微速前進！2！！"] }, sites: [{ site: "bangumi", id: String(id) }] },
        { title: "Other season", titleTranslate: { "zh-Hant": ["第一季"] }, sites: [{ site: "bangumi", id: "454082" }] },
      ] });
    }
    assert.equal(url.origin, env.BANGUMI_API_BASE, "Structured detail must not request HTML");
    switch (url.pathname) {
      case `/v0/subjects/${id}`:
        await subjectGate.promise;
        return Response.json(rawSubject(id));
      case "/v0/episodes":
        assert.equal(url.searchParams.get("subject_id"), String(id));
        return Response.json({ data: [{ id: 11, type: 0, sort: 1, name: "Episode" }] });
      case `/v0/subjects/${id}/characters`:
        return Response.json([{ id: 21, name: "Character" }]);
      case `/v0/subjects/${id}/persons`:
        return Response.json([{ id: 31, name: "Director", relation: "导演" }]);
      case `/v0/subjects/${id}/subjects`:
        return Response.json([{ id: 41, name: "Related" }]);
      case "/calendar":
        return Response.json([]);
      case "/v0/search/subjects":
        return Response.json({ data: [] });
      default:
        assert.fail(`Unexpected upstream request: ${url.pathname}`);
    }
  });

  const pending = readSubject(id, "?includeHtml=false&date=2026-01-15");
  try {
    // Drain already-resolved work; the subject gate remains closed throughout.
    await setImmediate();
    for (const path of [
      `/v0/subjects/${id}`,
      "/v0/episodes",
      `/v0/subjects/${id}/characters`,
      `/v0/subjects/${id}/persons`,
      `/v0/subjects/${id}/subjects`,
      "/schedule.json",
    ]) {
      assert.ok(paths.includes(path), `${path} must start while the subject is pending`);
    }
  } finally {
    subjectGate.resolve();
  }

  const response = await pending;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cache.hit, false);
  assert.equal(paths.includes("/calendar"), false, "Detail must not build the full timetable");
  assert.equal(paths.includes("/v0/search/subjects"), false, "Detail must not fetch seasonal enrichment");
  assert.deepEqual(body.data.aliases, ["Original", "微速前行 第二季", "微速前進！2！！"]);
  assert.equal(paths.filter((path) => path === "/schedule.json").length, 1);
  assert.equal(body.data.episodes[0].episodeId, 11);
  assert.equal(body.data.characters[0].characterId, 21);
  assert.equal(body.data.staff[0].personId, 31);
  assert.equal(body.data.relatedSubjects[0].subjectId, 41);
  assert.deepEqual(body.data.comments, []);
  assert.deepEqual(body.data.topics, []);
  assert.deepEqual(body.data.source.notes, []);

  paths.length = 0;
  const cached = await readSubject(id, "?includeHtml=false&date=2026-01-15");
  const cachedBody = await cached.json();
  assert.equal(cachedBody.cache.hit, true);
  assert.deepEqual(cachedBody.data, body.data);
  assert.deepEqual(paths, []);
});

test("expired structured details return before background revalidation finishes", async (t) => {
  const id = 90005;
  const expected = await seedDetail(id);
  await writeJson(env, cacheKey(["subjects", id, "full-v3"]), {
    value: expected,
    cachedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const subjectGate = Promise.withResolvers();
  const tasks = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === `/v0/subjects/${id}`) {
      await subjectGate.promise;
      return Response.json({ ...rawSubject(id), name_cn: "Updated title" });
    }
    if (url.pathname === "/v0/episodes") return Response.json({ data: [] });
    return Response.json([]);
  });
  let completed = false;
  const response = worker.fetch(
    new Request(`https://melon.example.test/v1/subjects/${id}?includeHtml=false`),
    env,
    { waitUntil(task) { tasks.push(task); } },
  ).then((response) => { completed = true; return response; });
  try {
    await setImmediate();
    assert.equal(completed, true, "Cached detail must not await the remote subject");
    const body = await (await response).json();
    assert.equal(body.data.displayName, expected.displayName);
    assert.equal(body.cache.stale, true);
  } finally {
    subjectGate.resolve();
    await Promise.all(tasks);
  }
  const updated = await readSubject(id, "?includeHtml=false");
  assert.equal((await updated.json()).data.displayName, "Updated title");
});

test("cold detail responds while both source and final R2 writes are pending", async (t) => {
  const id = 90006;
  const writeGate = Promise.withResolvers();
  const tasks = [], writes = [];
  const requestEnv = {
    ...env,
    BANGUMI_DATA_SOURCE: "https://data.example.test/cold-rules.json",
    CACHE_BUCKET: {
      async get() { return null; },
      async put(key) { writes.push(key); await writeGate.promise; },
    },
  };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/cold-rules.json") return Response.json({ items: [] });
    if (url.pathname === `/v0/subjects/${id}`) return Response.json(rawSubject(id));
    if (url.pathname === "/v0/episodes") return Response.json({ data: [] });
    return Response.json([]);
  });
  let completed = false;
  const response = worker.fetch(
    new Request(`https://melon.example.test/v1/subjects/${id}?includeHtml=false`),
    requestEnv,
    { waitUntil(task) { tasks.push(task); } },
  ).then((response) => { completed = true; return response; });
  try {
    await setImmediate();
    assert.equal(completed, true, "Source and final R2 persistence must not delay cold detail");
    assert.equal((await response).status, 200);
    assert.equal(writes.length, 2);
    assert.ok(writes.some((key) => key.startsWith("source/bangumi-data/")));
    assert.ok(writes.includes(`subjects/${id}/full-v3`));
  } finally {
    writeGate.resolve();
    await Promise.all(tasks);
  }
});
