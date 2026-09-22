import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { getOrSetJson, writeJson } from "../src/cache.ts";

function envelope(value, offset = 60_000) {
  return { value, cachedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + offset).toISOString() };
}

test("concurrent R2 reads share one lookup and later hits stay in memory", async () => {
  const gate = Promise.withResolvers();
  let reads = 0;
  const env = { CACHE_BUCKET: { async get() { reads++; await gate.promise; return { async json() { return envelope({ name: "Stored" }); } }; } } };
  const load = () => getOrSetJson(env, "test/r2-promotion", { ttlSeconds: 60 }, () => assert.fail("No upstream load expected"));
  const first = load(), second = load();
  await setImmediate();
  assert.equal(reads, 1);
  gate.resolve();
  assert.deepEqual((await first).value, { name: "Stored" });
  assert.equal((await second).cache.hit, true);
  assert.equal((await load()).cache.hit, true);
  assert.equal(reads, 1);
});

test("cold same-key requests share one loader and failed loads can retry", async () => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const loader = async () => { calls++; return gate.promise; };
  const first = getOrSetJson({}, "test/shared-load", { ttlSeconds: 60 }, loader);
  const second = getOrSetJson({}, "test/shared-load", { ttlSeconds: 60 }, loader);
  await setImmediate();
  assert.equal(calls, 1);
  gate.resolve({ value: 42 });
  assert.deepEqual((await first).value, { value: 42 });
  assert.deepEqual((await second).value, { value: 42 });
  await assert.rejects(getOrSetJson({}, "test/retry", { ttlSeconds: 60 }, async () => { throw Error("Offline"); }));
  assert.equal((await getOrSetJson({}, "test/retry", { ttlSeconds: 60 }, async () => "Recovered")).value, "Recovered");
});

test("stale reads return immediately while one background refresh updates the cache", async () => {
  const key = "test/stale-background";
  await writeJson({}, key, envelope("Saved", -1000));
  const gate = Promise.withResolvers();
  const background = [];
  let calls = 0;
  const loader = async () => { calls++; return gate.promise; };
  const policy = { ttlSeconds: 60, staleWhileRevalidateSeconds: 3600 };
  const first = await getOrSetJson({}, key, policy, loader, (task) => background.push(task));
  const second = await getOrSetJson({}, key, policy, loader, (task) => background.push(task));
  assert.equal(first.value, "Saved");
  assert.equal(first.cache.stale, true);
  assert.equal(second.value, "Saved");
  assert.equal(calls, 1);
  gate.resolve("Updated");
  await Promise.all(background);
  const fresh = await getOrSetJson({}, key, policy, loader);
  assert.equal(fresh.value, "Updated");
  assert.equal(fresh.cache.stale, undefined);
});

test("force refresh waits for new data even when stale background reads are allowed", async () => {
  const key = "test/forced-refresh";
  await writeJson({}, key, envelope("Saved", -1000));
  const gate = Promise.withResolvers();
  let completed = false;
  const response = getOrSetJson({}, key, { ttlSeconds: 60, force: true, staleWhileRevalidateSeconds: 3600 }, () => gate.promise, () => assert.fail("Force must wait")).then((result) => { completed = true; return result; });
  await setImmediate();
  assert.equal(completed, false);
  gate.resolve("New");
  assert.equal((await response).value, "New");
});

test("a request context persists to R2 after publishing the fresh memory value", async () => {
  const gate = Promise.withResolvers();
  const tasks = [];
  let writes = 0, completed = false;
  const env = { CACHE_BUCKET: { async get() { return null; }, async put() { writes++; await gate.promise; } } };
  const response = getOrSetJson(env, "test/background-write", { ttlSeconds: 60 }, async () => "Fresh", (task) => tasks.push(task))
    .then((value) => { completed = true; return value; });
  try {
    await setImmediate();
    assert.equal(completed, true, "R2 persistence must not delay the response");
    assert.equal((await response).value, "Fresh");
    assert.equal(writes, 1);
    const cached = await getOrSetJson(env, "test/background-write", { ttlSeconds: 60 }, () => assert.fail("Fresh value is already in memory"));
    assert.equal(cached.value, "Fresh");
  } finally {
    gate.resolve();
    await Promise.all(tasks);
  }
});
