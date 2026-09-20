import test from "node:test";
import assert from "node:assert/strict";
import {JobTracker} from "../addon/lifecycle.mjs";
function fixture() {
  let value = {};
  const storage = {get: async () => structuredClone(value), set: async data => { value = {...value, ...structuredClone(data)}; }};
  const calls = [];
  const request = async (...args) => { calls.push(args); return {}; };
  return {storage, calls, request, tracker: new JobTracker(storage, request)};
}
test("closing a dashboard cancels its job with the captured endpoint and token", async () => {
  const f = fixture(); const settings = {origin: "https://home.example:9443", token: "old-token"};
  await f.tracker.register(3, "job-old", settings);
  settings.origin = "https://replacement.example"; settings.token = "new-token";
  await f.tracker.cancel(3);
  assert.deepEqual(f.calls, [[{origin: "https://home.example:9443", token: "old-token"}, "/v1/jobs/job-old", {method: "DELETE"}]]);
});
test("a resumed MV3 background can cancel jobs from session storage after settings change", async () => {
  const f = fixture();
  await f.tracker.register(1, "first", {origin: "https://one.example", token: "one"});
  await f.tracker.register(2, "second", {origin: "https://two.example", token: "two"});
  const resumed = new JobTracker(f.storage, f.request);
  await resumed.cancelAll();
  assert.equal(f.calls.length, 2); assert.deepEqual((await f.storage.get()).pendingJobs, {});
});
test("late cancellation from an older run cannot cancel its replacement job", async () => {
  const f = fixture();
  await f.tracker.register(1, "new-job", {origin: "https://home.example", token: "token"});
  assert.equal(await f.tracker.cancel(1, "old-job"), false);
  assert.equal(f.calls.length, 0); assert.equal((await f.storage.get()).pendingJobs[1].id, "new-job");
});
test("released completed jobs are not cancelled on later tab close", async () => {
  const f = fixture();
  await f.tracker.register(1, "completed", {origin: "https://home.example", token: "token"});
  await f.tracker.release(1, "completed"); await f.tracker.cancel(1);
  assert.equal(f.calls.length, 0);
});
test("concurrent cancel triggers cause only one cancellation request", async () => {
  const f = fixture();
  await f.tracker.register(1, "once", {origin: "https://home.example", token: "token"});
  await Promise.all([f.tracker.cancel(1), f.tracker.cancel(1), f.tracker.cancelAll()]);
  assert.equal(f.calls.length, 1);
});
