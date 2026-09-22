import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import worker from "../src/index.ts";

test("long-running episode routes return every page even when the upstream caps pages", async (t) => {
  let active = 0, maximum = 0;
  const offsets = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/v0/episodes");
    assert.equal(url.searchParams.get("subject_id"), "212153");
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    active++;
    maximum = Math.max(maximum, active);
    await setImmediate();
    active--;
    return Response.json({ total: 742, limit: 100, offset, data: Array.from({ length: Math.min(100, 742 - offset) }, (_, index) => ({ id: offset + index + 1, type: 0, sort: offset + index + 1, name: `Episode ${offset + index + 1}` })) });
  });
  const response = await worker.fetch(new Request("https://melon.test/v1/subjects/212153/episodes"), { BANGUMI_API_BASE: "https://episodes.test" }, { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 742);
  assert.equal(body.data[741].episodeId, 742);
  assert.deepEqual(body.data.map((episode) => episode.sort), Array.from({ length: 742 }, (_, index) => index + 1));
  assert.deepEqual(offsets, [0, 100, 200, 300, 400, 500, 600, 700]);
  assert.equal(maximum, 4);
  assert.equal(body.cache.key, "subjects/212153/episodes-v2");
});
