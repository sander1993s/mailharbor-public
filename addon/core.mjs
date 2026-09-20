export const MAX_MESSAGES = 40;
export const MAX_BODY = 8000;
export class MailHarborError extends Error {
  constructor(code, message) { super(message); this.name = "MailHarborError"; this.code = code; }
}
const fail = (code, message) => { throw new MailHarborError(code, message); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (obj, keys) => record(obj) && Object.keys(obj).every(key => keys.includes(key));
const string = (value, max) => typeof value === "string" && value.length <= max;
const clean = value => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
const clip = (value, max) => clean(value).slice(0, max);
export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value.trim()); } catch { fail("configuration_error", "Enter a valid HTTPS server origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("configuration_error", "Use only an HTTPS origin, without a path, query, or credentials.");
  }
  return url.origin;
}
// WebExtension match patterns cover the host (all ports). Fetch separately enforces the exact configured origin.
export function originPattern(origin) { const url = new URL(normalizeOrigin(origin)); return `https://${url.hostname}/*`; }
export function validJobId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id); }
export async function apiRequest(settings, path, options = {}, fetcher = fetch) {
  const origin = normalizeOrigin(settings.origin);
  if (!settings.token || /[\r\n]/.test(settings.token)) fail("configuration_error", "Save a valid pairing token in Settings.");
  if (!/^\/v1\/(?:status|jobs(?:\/[A-Za-z0-9_-]{1,100})?)$/.test(path)) fail("invalid_request", "Invalid service endpoint.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, {once: true});
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 20000);
  try {
    const response = await fetcher(origin + path, {
      method: options.method || "GET", redirect: "error", cache: "no-store", credentials: "omit",
      referrerPolicy: "no-referrer", signal: controller.signal,
      headers: {"Authorization": `Bearer ${settings.token}`, "Accept": "application/json", ...(options.body ? {"Content-Type": "application/json"} : {})},
      ...(options.body ? {body: JSON.stringify(options.body)} : {})
    });
    // Defense in depth: fetch mocks, future wrappers, and nonstandard implementations must not follow auth redirects.
    if (response.redirected || (response.url && response.url !== origin + path)) fail("connection_error", "The server redirected the request. Check its HTTPS address.");
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) fail("connection_error", "The server returned a non-JSON response. Check the address and login state.");
    const raw = await response.text();
    if (raw.length > 128 * 1024) fail("invalid_response", "The server response was too large.");
    let payload;
    try { payload = JSON.parse(raw); } catch { fail("invalid_response", "The server returned invalid JSON."); }
    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "provider_error";
      // Never echo server response bodies or supplied tokens into the UI.
      const messages = {
        unauthorized: "Pairing token rejected. Update it in Settings.", login_required: "Agy needs a manual login on the homeserver.",
        quota_exhausted: "Google quota is exhausted. Retry after the quota resets.", busy: "The homeserver queue is full. Try again later.",
        timeout: "The analysis timed out. Your emails were not changed.", invalid_model_output: "The model response could not be verified. Your emails were not changed.",
        configuration_error: "The homeserver needs configuration. Check its local status.", not_found: "This analysis expired. Create a new briefing."
      };
      fail(code, messages[code] || "The homeserver could not complete the request.");
    }
    return payload;
  } catch (error) {
    if (error instanceof MailHarborError) throw error;
    if (options.signal?.aborted) fail("cancelled", "Cancelled. Your emails were not changed.");
    fail("connection_error", "Cannot reach the homeserver. Check Tailscale, the HTTPS address, and server status.");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
export function validateResult(result, inputs) {
  if (!exactKeys(result, ["briefing", "items"]) || !string(result.briefing, 12000) || !Array.isArray(result.items) || result.items.length !== inputs.length) fail("invalid_model_output", "The briefing did not match this batch.");
  const expected = new Map(inputs.map(input => [input.id, input]));
  const seen = new Set();
  for (const item of result.items) {
    if (!exactKeys(item, ["id", "summary", "priority", "category", "recommendation", "reason"]) ||
        !expected.has(item.id) || seen.has(item.id) || !string(item.summary, 1200) || !string(item.reason, 500) ||
        !["high", "normal", "low"].includes(item.priority) || !["action", "waiting", "invoice", "newsletter", "notification", "other"].includes(item.category) ||
        !["keep", "archive"].includes(item.recommendation)) fail("invalid_model_output", "An analysis item failed validation. Your emails were not changed.");
    const input = expected.get(item.id);
    if ((input.truncated || input.bodyUnavailable) && item.recommendation !== "keep") fail("invalid_model_output", "Incomplete emails cannot be recommended for archive.");
    seen.add(item.id);
  }
  const renderedText = [result.briefing, ...result.items.flatMap(item => [item.summary, item.reason])];
  if (renderedText.some(text => /<\/?[A-Za-z][^>]*>|\b(?:https?|javascript|data|file):/i.test(text))) fail("invalid_model_output", "The model returned markup or links instead of a plain-text briefing.");
  return result;
}
const header = (part, name) => Object.entries(part.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1]?.join(" ") || "";
const mimeType = part => (part.contentType || header(part, "content-type")).split(";")[0].trim().toLowerCase();
const isAttachment = part => !!part.name || /^attachment\b/i.test(header(part, "content-disposition")) || /(?:^|;)\s*(?:filename|name)\s*=/i.test(header(part, "content-disposition") + ";" + header(part, "content-type"));
function encrypted(part) {
  const type = mimeType(part);
  if (part.decryptionStatus && part.decryptionStatus !== "none") return true;
  if (["multipart/encrypted", "application/pkcs7-mime", "application/x-pkcs7-mime", "application/pgp-encrypted"].includes(type)) return true;
  return !isAttachment(part) && (part.parts || []).some(child => !isAttachment(child) && encrypted(child));
}
export async function extractPlain(full, htmlToText = async () => "") {
  if (!record(full) || encrypted(full)) return {body: "", truncated: false, bodyUnavailable: true, note: "Encrypted content excluded"};
  async function walk(part, root = false) {
    if (!root && (isAttachment(part) || mimeType(part) === "message/rfc822")) return "";
    const type = mimeType(part);
    if (type === "text/plain") return typeof part.body === "string" ? part.body : "";
    if (type === "text/html") return typeof part.body === "string" ? await htmlToText(part.body) : "";
    const children = part.parts || [];
    if (type === "multipart/alternative") {
      const plain = children.find(p => mimeType(p) === "text/plain" && !isAttachment(p));
      if (plain) { const value = await walk(plain); if (value.trim()) return value; }
      const html = children.find(p => mimeType(p) === "text/html" && !isAttachment(p));
      return html ? walk(html) : "";
    }
    const chunks = [];
    for (const child of children) { const value = await walk(child); if (value.trim()) chunks.push(value); }
    return chunks.join("\n\n");
  }
  const text = clean(await walk(full, true)).replace(/\r\n?/g, "\n").trim();
  if (/-----BEGIN PGP MESSAGE-----/.test(text)) return {body: "", truncated: false, bodyUnavailable: true, note: "Encrypted content excluded"};
  const truncated = text.length > MAX_BODY;
  return {body: text.slice(0, MAX_BODY), truncated, bodyUnavailable: !text, note: truncated ? "Body limited to 8,000 characters" : !text ? "No readable inline body" : ""};
}
function metadata(message) {
  return JSON.stringify({account: message.folder?.accountId, folder: message.folder?.id, messageId: message.headerMessageId,
    author: message.author, subject: message.subject, date: new Date(message.date).toISOString(), size: message.size,
    recipients: message.recipients, cc: message.ccList, bcc: message.bccList, read: message.read, flagged: message.flagged,
    junk: message.junk, tags: message.tags});
}
async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
}
export class MailSession {
  constructor(api, {htmlToText, uuid = () => crypto.randomUUID()} = {}) {
    this.api = api; this.htmlToText = htmlToText || (html => api.messengerUtilities.convertToPlainText(html));
    this.uuid = uuid; this.entries = new Map(); this.generation = 0;
  }
  clear() { this.generation++; this.entries.clear(); this.cancelHeaderWait?.(); }
  async body(id) {
    try { return await extractPlain(await this.api.messages.getFull(id, {decrypt: false, decodeContent: true, decodeHeaders: true}), this.htmlToText); }
    catch { return {body: "", truncated: false, bodyUnavailable: true, note: "Body unavailable; check the original email"}; }
  }
  async scan(accountIds, {signal, onProgress = () => {}, onHeaderProgress = () => {}} = {}) {
    this.clear();
    const generation = this.generation;
    const assertLive = () => { if (signal?.aborted || this.generation !== generation) fail("cancelled", "Scan cancelled."); };
    const accounts = await this.api.accounts.list(false);
    const names = new Map(accounts.map(a => [a.id, a.name]));
    const folders = (await this.api.folders.query({specialUse: ["inbox"]})).filter(f => accountIds.includes(f.accountId) && !f.isVirtual && !f.isUnified && !f.isTag);
    if (!folders.length) fail("configuration_error", "No real inboxes found for the selected accounts.");
    // Keep only the newest 40 plus one sentinel while traversing every header.
    // Thunderbird's query enumeration order is not a newest-first guarantee.
    const newest = [];
    let observed = 0;
    const retain = message => {
      const key = `${message.folder.accountId}\0${message.id}`;
      if (newest.some(candidate => candidate.key === key)) return;
      const time = new Date(message.date).getTime();
      if (!Number.isFinite(time)) fail("invalid_message", "An email has an invalid date. Check it in Thunderbird.");
      if (newest.length === MAX_MESSAGES + 1 && time <= newest.at(-1).time) return;
      const position = newest.findIndex(candidate => time > candidate.time);
      newest.splice(position < 0 ? newest.length : position, 0, {message, key, time});
      if (newest.length > MAX_MESSAGES + 1) newest.pop();
    };
    for (const folder of folders) {
      assertLive();
      let listId = null, closed = false;
      const abortList = () => {
        const id = listId; listId = null;
        if (id) {
          try { Promise.resolve(this.api.messages.abortList(id)).catch(() => {}); } catch {}
        }
      };
      const wait = async operation => {
        let onAbort;
        const cancelled = new Promise((resolve, reject) => {
          onAbort = () => { abortList(); reject(new MailHarborError("cancelled", "Scan cancelled.")); };
          this.cancelHeaderWait = onAbort;
          signal?.addEventListener("abort", onAbort, {once: true});
        });
        try {
          if (signal?.aborted) onAbort();
          return await Promise.race([operation, cancelled]);
        } finally {
          signal?.removeEventListener("abort", onAbort);
          if (this.cancelHeaderWait === onAbort) this.cancelHeaderWait = null;
        }
      };
      try {
        // Acquiring the list ID first lets Cancel interrupt a pending page, even
        // while Thunderbird is still searching a large local message database.
        const started = this.api.messages.query({folderId: folder.id, read: false, includeSubFolders: false,
          returnMessageListId: true, messagesPerPage: 250}).then(id => {
          if (typeof id !== "string" || !id) fail("invalid_response", "Thunderbird returned an invalid message list.");
          listId = id;
          // A query may finish after cancellation; its newly returned ID still
          // needs finalizing even though the scan already rejected.
          if (closed || signal?.aborted || this.generation !== generation) abortList();
        });
        await wait(started);
        assertLive();
        while (listId) {
          const page = await wait(this.api.messages.continueList(listId));
          assertLive();
          listId = page.id;
          for (const message of page.messages) {
            if (message.external || message.read !== false || message.folder?.id !== folder.id || message.folder?.accountId !== folder.accountId) continue;
            observed++;
            retain(message);
          }
          onHeaderProgress(observed);
          assertLive();
        }
      } finally { closed = true; abortList(); }
    }
    const capped = newest.length > MAX_MESSAGES;
    const candidates = newest.slice(0, MAX_MESSAGES).map(candidate => candidate.message);
    for (const message of candidates) {
      assertLive();
      const extracted = await this.body(message.id);
      assertLive();
      const id = this.uuid();
      const input = {id, account: clip(names.get(message.folder.accountId) || message.folder.accountId, 500),
        author: clip(message.author, 500), subject: clip(message.subject, 500), date: new Date(message.date).toISOString(),
        body: extracted.body, truncated: extracted.truncated, bodyUnavailable: extracted.bodyUnavailable};
      this.entries.set(id, {input, messageId: message.id, meta: metadata(message), fingerprint: await digest(JSON.stringify(extracted)), note: extracted.note,
        accountId: message.folder.accountId, folderId: message.folder.id, generation, done: false});
      onProgress(this.entries.size, candidates.length);
    }
    assertLive();
    // Body limits are character-based; CJK/emoji can exceed the service's byte budget even below that limit.
    const payload = () => ({language: "en", messages: [...this.entries.values()].map(e => e.input)});
    while (new TextEncoder().encode(JSON.stringify(payload())).length > 500 * 1024) {
      const longest = [...this.entries.values()].sort((a, b) => b.input.body.length - a.input.body.length)[0];
      if (!longest?.input.body.length) fail("invalid_request", "This batch is too large to send.");
      longest.input.body = longest.input.body.slice(0, Math.floor(longest.input.body.length * 0.8));
      longest.input.truncated = true;
      longest.note = "Body shortened to fit the briefing batch";
    }
    return {messages: [...this.entries.values()].map(e => e.input), capped, observed, accounts: folders.length};
  }
  async apply(id, action) {
    if (!["archive", "markRead"].includes(action)) fail("invalid_action", "Unsupported email action.");
    const entry = this.entries.get(id);
    if (!entry || entry.done || entry.applying || entry.generation !== this.generation) fail("stale_message", "This email is no longer part of the active review. Scan again.");
    if (action === "archive" && (entry.input.truncated || entry.input.bodyUnavailable)) fail("incomplete_message", "Open the original email before deciding how to archive incomplete content.");
    entry.applying = true;
    try {
      let current;
      try { current = await this.api.messages.get(entry.messageId); } catch { fail("stale_message", "This email moved or disappeared. Scan again."); }
      const folder = await this.api.folders.get(entry.folderId);
      if (entry.generation !== this.generation || current.external || current.read !== false || !folder.specialUse?.includes("inbox") || folder.isVirtual || folder.isUnified ||
          current.folder?.accountId !== entry.accountId || folder.accountId !== entry.accountId || metadata(current) !== entry.meta) fail("stale_message", "This email changed since the scan. Scan again before applying an action.");
      const extracted = await this.body(entry.messageId);
      if (await digest(JSON.stringify(extracted)) !== entry.fingerprint || entry.generation !== this.generation) fail("stale_message", "This email's content changed. Scan again.");
      // Recheck metadata after body I/O; the user or another client may have moved the message meanwhile.
      if (metadata(await this.api.messages.get(entry.messageId)) !== entry.meta) fail("stale_message", "This email changed during review. Scan again.");
      if (action === "archive") await this.api.messages.archive([entry.messageId]);
      else await this.api.messages.update(entry.messageId, {read: true});
      entry.done = true;
      return true;
    } finally { entry.applying = false; }
  }
}
