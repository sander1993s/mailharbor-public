import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {apiRequest, extractPlain, MailSession, normalizeOrigin, originPattern, validateResult} from "../addon/core.mjs";

const inbox = {id: "folder-1", accountId: "account-1", specialUse: ["inbox"], isVirtual: false, isUnified: false};
const header = (id = 1, changes = {}) => ({id, folder: {...inbox}, headerMessageId: `<${id}@example.test>`, date: new Date("2026-01-01T10:00:00Z"), author: "Sender <sender@example.test>", subject: `Email ${id}`, size: 150, recipients: ["recipient@example.test"], ccList: [], bccList: [], read: false, flagged: false, junk: false, tags: [], ...changes});
function fixture(headers = [header()]) {
  const current = new Map(headers.map(h => [h.id, structuredClone(h)]));
  const calls = {archive: [], update: [], full: [], query: [], abort: []};
  let full = {contentType: "text/plain", body: "A useful ordinary message.", decryptionStatus: "none"};
  const api = {
    accounts: {list: async () => [{id: "account-1", name: "Business", type: "imap"}]},
    folders: {query: async () => [inbox], get: async () => ({...inbox})},
    messages: {
      query: async q => { calls.query.push(q); return "fixture-list"; },
      continueList: async id => { assert.equal(id, "fixture-list"); return {id: null, messages: [...current.values()].map(v => structuredClone(v))}; },
      abortList: async id => calls.abort.push(id),
      getFull: async (id, options) => { calls.full.push({id, options}); if (!current.has(id)) throw new Error("Missing"); return structuredClone(full); },
      get: async id => { if (!current.has(id)) throw new Error("Missing"); return structuredClone(current.get(id)); },
      archive: async ids => calls.archive.push(ids), update: async (id, value) => calls.update.push({id, value})
    }
  };
  let count = 0;
  const session = new MailSession(api, {uuid: () => `opaque-${++count}`, htmlToText: async html => html.replace(/<[^>]*>/g, "")});
  return {api, current, calls, session, setBody: value => { full = value; }};
}
const input = {id: "opaque-1", account: "Business", author: "Sender", subject: "Hello", date: "2026-01-01", body: "Hello", truncated: false, bodyUnavailable: false};
const item = {id: "opaque-1", summary: "A normal notification.", priority: "low", category: "notification", recommendation: "archive", reason: "No action needed."};
const result = changes => ({briefing: "One notification.", items: [{...item, ...changes}]});
const jsonResponse = (payload, overrides = {}) => ({ok: true, redirected: false, url: "https://mail.example:9443/v1/status", headers: new Headers({"Content-Type": "application/json"}), text: async () => JSON.stringify(payload), ...overrides});

test("only HTTPS origins are accepted; host grant excludes port but request preserves it", async () => {
  assert.equal(normalizeOrigin("https://mail.example:9443/"), "https://mail.example:9443");
  assert.equal(originPattern("https://mail.example:9443"), "https://mail.example/*");
  for (const value of ["http://mail.example", "https://user:pass@mail.example", "https://mail.example/path", "https://mail.example/?token=secret", "https://mail.example/#hash"]) assert.throws(() => normalizeOrigin(value));
  await apiRequest({origin: "https://mail.example:9443", token: "pairing-secret"}, "/v1/status", {}, async (url, options) => {
    assert.equal(url, "https://mail.example:9443/v1/status"); assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); assert.equal(options.headers.Authorization, "Bearer pairing-secret");
    return jsonResponse({ready: true});
  });
});
test("auth redirects and cross-origin or wrong-port responses fail closed", async () => {
  for (const response of [jsonResponse({}, {redirected: true}), jsonResponse({}, {url: "https://evil.example/v1/status"}), jsonResponse({}, {url: "https://mail.example/v1/status"})]) {
    await assert.rejects(apiRequest({origin: "https://mail.example:9443", token: "secret"}, "/v1/status", {}, async () => response), error => error.code === "connection_error");
  }
});
test("errors do not reflect service-provided body or tokens into the UI", async () => {
  await assert.rejects(apiRequest({origin: "https://mail.example:9443", token: "secret"}, "/v1/status", {}, async () => jsonResponse({error: {code: "unauthorized", message: "secret <script>alert(1)</script>"}}, {ok: false})), error => error.code === "unauthorized" && !error.message.includes("secret") && !error.message.includes("script"));
});
test("MIME extraction picks plain alternative, excludes text attachments and attached emails", async () => {
  const body = await extractPlain({contentType: "multipart/mixed", parts: [
    {contentType: "multipart/alternative", parts: [{contentType: "text/plain", body: "Readable plain text."}, {contentType: "text/html", body: "<p>duplicate</p>"}]},
    {contentType: "text/plain", headers: {"content-disposition": ["attachment; filename=secret.txt"]}, body: "PRIVATE ATTACHMENT"},
    {contentType: "message/rfc822", parts: [{contentType: "text/plain", body: "ATTACHED EMAIL"}]}
  ]}, async () => { throw new Error("HTML should not be read"); });
  assert.equal(body.body, "Readable plain text."); assert.equal(body.bodyUnavailable, false);
});
test("HTML-only text is converted with the provided safe converter", async () => {
  let called = 0;
  const extracted = await extractPlain({contentType: "text/html", body: "<p>Hello</p>"}, async html => { called++; assert.equal(html, "<p>Hello</p>"); return "Hello"; });
  assert.equal(extracted.body, "Hello"); assert.equal(called, 1);
});
test("encrypted content, including pre-decrypted and inline PGP, is never returned", async () => {
  for (const full of [{contentType: "multipart/encrypted", parts: [{contentType: "text/plain", body: "secret"}]}, {contentType: "text/plain", body: "secret", decryptionStatus: "success"}, {contentType: "application/pkcs7-mime", body: "secret"}, {contentType: "text/plain", body: "-----BEGIN PGP MESSAGE-----\nsecret"}]) {
    const extracted = await extractPlain(full); assert.equal(extracted.body, ""); assert.equal(extracted.bodyUnavailable, true);
  }
});
test("body limits and control stripping are explicit", async () => {
  const extracted = await extractPlain({contentType: "text/plain", body: "Good\u0000\u0001\u000b\u007f text\n" + "x".repeat(9000)});
  assert.equal(extracted.body.length, 8000); assert.equal(extracted.truncated, true); assert.ok(extracted.body.startsWith("Good text\n"));
});
test("scan scopes real selected inboxes, paginates, uses opaque IDs, and preserves unread state", async () => {
  const f = fixture();
  f.api.folders.query = async () => [inbox, {...inbox, id: "virtual", isVirtual: true}, {...inbox, id: "other", accountId: "not-selected"}];
  let page = 0;
  f.api.messages.continueList = async id => { assert.equal(id, "fixture-list"); return ++page === 1 ?
    {id, messages: [header()]} : {id: null, messages: [header(2)]}; };
  f.current.set(2, header(2));
  const batch = await f.session.scan(["account-1"]);
  assert.equal(batch.messages.length, 2); assert.equal(f.calls.query.length, 1); assert.deepEqual(f.calls.query[0], {
    folderId: "folder-1", read: false, includeSubFolders: false, returnMessageListId: true, messagesPerPage: 250});
  assert.equal(batch.messages[0].id, "opaque-1"); assert.equal(f.calls.archive.length, 0); assert.equal(f.calls.update.length, 0);
  assert.ok(f.calls.full.every(call => call.options.decrypt === false));
});
test("46,000 old-first headers select the global newest 40 across inboxes without reading other bodies", async () => {
  const secondInbox = {...inbox, id: "folder-2", accountId: "account-2"};
  const dated = (id, folder = inbox) => header(id, {date: new Date(1700000000000 + id * 1000), folder});
  const selectedIds = Array.from({length: 40}, (_, i) => 46010 - i);
  const f = fixture(selectedIds.map(id => dated(id, id > 46000 ? secondInbox : inbox)));
  f.api.accounts.list = async () => [{id: "account-1", name: "Business"}, {id: "account-2", name: "Personal"}];
  f.api.folders.query = async () => [inbox, secondInbox];
  const offsets = new Map();
  f.api.messages.query = async q => { f.calls.query.push(q); offsets.set(q.folderId, 0); return q.folderId; };
  let pages = 0;
  f.api.messages.continueList = async listId => {
    pages++;
    const second = listId === secondInbox.id, count = second ? 10 : 46000;
    const start = offsets.get(listId), end = Math.min(start + 250, count);
    offsets.set(listId, end);
    const messages = Array.from({length: end - start}, (_, i) => dated((second ? 46000 : 0) + start + i + 1, second ? secondInbox : inbox));
    // Newer but ineligible headers must neither displace eligible mail nor inflate progress.
    if (!start) messages.unshift(dated(99000, {...inbox, accountId: "unselected"}),
      {...dated(99001), read: true}, {...dated(99002), external: true});
    return {id: end === count ? null : listId, messages};
  };
  const progress = [], bodyProgress = [];
  const batch = await f.session.scan(["account-1", "account-2"], {
    onHeaderProgress: count => progress.push(count), onProgress: (done, total) => bodyProgress.push([done, total])});
  assert.deepEqual(f.calls.full.map(call => call.id), selectedIds);
  assert.equal(batch.messages.length, 40); assert.equal(batch.capped, true); assert.equal(batch.observed, 46010);
  assert.equal(pages, 185); assert.equal(progress.length, pages); assert.equal(progress.at(-1), 46010);
  assert.deepEqual(bodyProgress.at(-1), [40, 40]); assert.deepEqual(f.calls.abort, []);
});
test("cancelling or clearing a pending header page immediately aborts its list and reads no bodies", async () => {
  for (const clearSession of [false, true]) {
    const f = fixture();
    const controller = new AbortController();
    let pageStarted;
    const waiting = new Promise(resolve => { pageStarted = resolve; });
    f.api.messages.continueList = async () => { pageStarted(); return new Promise(() => {}); };
    const scanning = f.session.scan(["account-1"], clearSession ? {} : {signal: controller.signal});
    const rejection = assert.rejects(scanning, error => error.code === "cancelled");
    await waiting;
    if (clearSession) f.session.clear(); else controller.abort();
    await rejection;
    assert.deepEqual(f.calls.abort, ["fixture-list"]); assert.equal(f.calls.full.length, 0);
  }
});
test("a list ID arriving after query cancellation is still finalized", async () => {
  const f = fixture();
  const controller = new AbortController();
  let finishQuery, queryStarted;
  const waiting = new Promise(resolve => { queryStarted = resolve; });
  f.api.messages.query = () => { queryStarted(); return new Promise(resolve => { finishQuery = resolve; }); };
  const scanning = f.session.scan(["account-1"], {signal: controller.signal});
  const rejection = assert.rejects(scanning, error => error.code === "cancelled");
  await waiting; controller.abort(); await rejection;
  finishQuery("late-list"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.abort, ["late-list"]); assert.equal(f.calls.full.length, 0);
});
test("header-page failures finalize the active list before any body reads", async () => {
  for (const failProgress of [false, true]) {
    const f = fixture();
    f.api.messages.continueList = async () => {
      if (!failProgress) throw new Error("Page unavailable");
      return {id: "fixture-list", messages: [header()]};
    };
    await assert.rejects(f.session.scan(["account-1"], {onHeaderProgress: () => { throw new Error("Progress failed"); }}));
    assert.deepEqual(f.calls.abort, ["fixture-list"]); assert.equal(f.calls.full.length, 0);
  }
});
test("multilingual batches stay under the HTTP byte limit and shortened messages must stay", async () => {
  const f = fixture(Array.from({length: 40}, (_, i) => header(i + 1)));
  f.setBody({contentType: "text/plain", body: "漢".repeat(8000)});
  const batch = await f.session.scan(["account-1"]);
  assert.ok(Buffer.byteLength(JSON.stringify({language: "en", messages: batch.messages})) < 512 * 1024);
  assert.ok(batch.messages.some(m => m.truncated));
  const shortened = batch.messages.find(m => m.truncated);
  await assert.rejects(f.session.apply(shortened.id, "archive"), e => e.code === "incomplete_message");
});
test("archive and mark-read use native operations only after revalidation", async () => {
  const f = fixture(); const batch = await f.session.scan(["account-1"]);
  await f.session.apply(batch.messages[0].id, "archive"); assert.deepEqual(f.calls.archive, [[1]]);
  await assert.rejects(f.session.apply(batch.messages[0].id, "archive"), e => e.code === "stale_message");
  const g = fixture(); const read = await g.session.scan(["account-1"]); await g.session.apply(read.messages[0].id, "markRead");
  assert.deepEqual(g.calls.update, [{id: 1, value: {read: true}}]);
});
test("moved, missing, replaced, modified, already-read, and session-expired IDs cannot mutate", async () => {
  const mutations = [
    f => f.current.delete(1), f => { f.current.get(1).folder.id = "archive"; },
    f => { f.current.get(1).headerMessageId = "<different@example.test>"; }, f => { f.current.get(1).read = true; },
    f => f.setBody({contentType: "text/plain", body: "Changed after analysis"}), f => f.session.clear()
  ];
  for (const mutate of mutations) {
    const f = fixture(); const batch = await f.session.scan(["account-1"]); mutate(f);
    await assert.rejects(f.session.apply(batch.messages[0].id, "archive")); assert.equal(f.calls.archive.length, 0); assert.equal(f.calls.update.length, 0);
  }
});
test("change during full-body revalidation is caught before archive", async () => {
  const f = fixture(); const batch = await f.session.scan(["account-1"]);
  const original = f.api.messages.getFull;
  f.api.messages.getFull = async (...args) => { const full = await original(...args); f.current.get(1).folder.id = "elsewhere"; return full; };
  await assert.rejects(f.session.apply(batch.messages[0].id, "archive")); assert.equal(f.calls.archive.length, 0);
});
test("invalid model output, invented IDs/actions, duplicates and incomplete archive requests fail closed", () => {
  assert.equal(validateResult(result(), [input]).items[0].recommendation, "archive");
  for (const candidate of [result({id: "999"}), result({command: "delete all"}), result({recommendation: "delete"}), result({summary: "<img src=x onerror=alert(1)>"}), result({reason: "Visit https://evil.example"}), {briefing: "x", items: [item, item]}, {briefing: "x", items: []}]) assert.throws(() => validateResult(candidate, [input]));
  assert.throws(() => validateResult(result(), [{...input, truncated: true}]));
  assert.throws(() => validateResult(result(), [{...input, bodyUnavailable: true}]));
});
test("mail operations do not accept arbitrary action names", async () => {
  const f = fixture(); await f.session.scan(["account-1"]);
  await assert.rejects(f.session.apply("opaque-1", "delete"), e => e.code === "invalid_action");
});
test("rendering contains no innerHTML/eval and manifest grants no unconditional remote access", async () => {
  const source = await readFile(new URL("../addon/dashboard.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|\beval\s*\(/);
  const manifest = JSON.parse(await readFile(new URL("../addon/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3); assert.equal(manifest.host_permissions, undefined);
  assert.ok(!manifest.permissions.includes("messagesDelete")); assert.ok(!manifest.permissions.includes("nativeMessaging"));
});
