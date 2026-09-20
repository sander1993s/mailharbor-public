import {apiRequest, MailSession, MailHarborError, validJobId, validateResult} from "./core.mjs";
const $ = id => document.getElementById(id);
const make = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const session = new MailSession(messenger);
let settings = {}, batch, result, busy = false, controller, jobId, runNumber = 0, activeRun;
const tabReady = messenger.tabs.getCurrent();
async function trackJob(run) {
  const tab = await tabReady;
  await messenger.runtime.sendMessage({type: "mailharbor-job-track", tabId: tab.id, id: run.id, settings: run.settings});
  if (run.cancelled) await cancelRun(run);
}
async function cancelRun(run) {
  if (!run) return;
  run.cancelled = true;
  if (!run.id) return;
  const tab = await tabReady;
  await messenger.runtime.sendMessage({type: "mailharbor-job-cancel", tabId: tab.id, id: run.id});
}
function cancelActiveRun() { cancelRun(activeRun).catch(() => {}); controller?.abort(); }
const selected = new Set();
const statuses = new Map();
const notify = (message, type = "") => { $("notice").textContent = message; $("notice").className = `notice ${type}`; };
function updateActions() {
  $("selected-count").textContent = `${selected.size} selected`;
  $("archive").disabled = busy || !selected.size || [...selected].some(id => { const e = session.entries.get(id); return !e || e.done || e.input.truncated || e.input.bodyUnavailable; });
  $("mark-read").disabled = busy || !selected.size;
  $("scan").disabled = busy;
  $("play").disabled = !result?.briefing || !voices.length;
}
function setBusy(value) { busy = value; $("cancel").hidden = !value; $("scan").textContent = value ? "Working…" : "Create briefing →"; updateActions(); }
function render() {
  $("count").textContent = `${batch?.messages.length || 0} emails`;
  $("emails").replaceChildren();
  if (!batch?.messages.length) {
    const empty = make("div", undefined, "empty");
    empty.append(make("span", "✓", "empty-icon"), make("h3", "You're caught up."), make("p", "No unread emails were found in your selected inboxes."));
    $("emails").append(empty); updateActions(); return;
  }
  const items = new Map(result?.items.map(item => [item.id, item]) || []);
  const priorityOrder = {high: 0, normal: 1, low: 2};
  const inputs = [...batch.messages].sort((a, b) => (priorityOrder[items.get(a.id)?.priority] ?? 1) - (priorityOrder[items.get(b.id)?.priority] ?? 1));
  for (const input of inputs) {
    const entry = session.entries.get(input.id), item = items.get(input.id);
    const card = make("article", undefined, `email${entry?.done ? " done" : ""}${selected.has(input.id) ? " selected" : ""}`);
    const top = make("div", undefined, "email-top"), check = make("input");
    check.type = "checkbox"; check.checked = selected.has(input.id); check.disabled = busy || !entry || entry.done;
    check.setAttribute("aria-label", `Select ${input.subject || "email without a subject"}`);
    check.addEventListener("change", () => { if (check.checked) selected.add(input.id); else selected.delete(input.id); card.classList.toggle("selected", check.checked); updateActions(); });
    const content = make("div", undefined, "email-content"), meta = make("div", undefined, "email-meta");
    meta.append(make("span", input.account, "account-pill"), make("span", new Date(input.date).toLocaleDateString(undefined, {year: "numeric", month: "short", day: "numeric"})));
    if (item) meta.append(make("span", item.priority === "high" ? "NEEDS ATTENTION" : item.category.toUpperCase(), item.priority === "high" ? "priority-high" : ""));
    content.append(meta, make("h3", input.subject || "(No subject)"), make("p", input.author, "author"));
    if (item) {
      content.append(make("p", item.summary, "summary"), make("span", item.recommendation === "archive" ? "↘ Ready to archive" : "• Keep in inbox", `suggestion ${item.recommendation}`), make("p", item.reason, "reason"));
    } else content.append(make("p", "Waiting for your briefing…", "summary"));
    if (entry?.note) content.append(make("p", entry.note + ". Kept for manual review.", "fineprint warning"));
    if (statuses.has(input.id)) content.append(make("p", statuses.get(input.id), "fineprint"));
    const bottom = make("div", undefined, "email-bottom");
    const listen = make("button", "▶ Read email", "subtle"); listen.disabled = !voices.length || input.bodyUnavailable;
    listen.addEventListener("click", () => speak(`${input.subject}. From ${input.author}. ${input.body}${input.truncated ? " End of shortened email. Read the original for the rest." : ""}`, "Reading email"));
    bottom.append(listen);
    const details = make("details"), summary = make("summary", "View extracted email text");
    details.append(summary, make("pre", input.body || "Readable content is unavailable or excluded. Check this email in Thunderbird.", "original-body"));
    bottom.append(details); content.append(bottom); top.append(check, content); card.append(top); $("emails").append(card);
  }
  updateActions();
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => { clearTimeout(timer); reject(new MailHarborError("cancelled", "Cancelled.")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, {once: true});
});
async function run() {
  if (!settings.origin || !settings.token || !settings.accountIds?.length) { notify("Open Connection & accounts to choose your inboxes and pair your homeserver.", "error"); return; }
  stopSpeech(); selected.clear(); statuses.clear(); result = undefined; batch = undefined;
  $("briefing").textContent = "Gathering a little clarity from your inboxes…";
  setBusy(true); controller = new AbortController(); const signal = controller.signal; const currentRun = ++runNumber;
  const run = {settings: structuredClone(settings), id: undefined, cancelled: false}; activeRun = run;
  try {
    notify("Checking your homeserver…");
    const status = await apiRequest(run.settings, "/v1/status", {signal});
    if (status.ready !== true) throw new MailHarborError("configuration_error", "The homeserver is connected, but Agy is not ready. Complete its local login and setup.");
    batch = await session.scan(run.settings.accountIds, {signal,
      onHeaderProgress: count => notify(`Finding newest unread emails · ${count.toLocaleString()} headers checked.`),
      onProgress: (done, total) => notify(`Reading inline text · ${done} of ${total} emails. Attachments stay in Thunderbird.`)});
    if (currentRun !== runNumber) return;
    $("scope").textContent = `${batch.messages.length} newest unread emails from ${batch.accounts} inbox${batch.accounts === 1 ? "" : "es"}.${batch.capped ? ` Batch capped at 40; ${batch.observed.toLocaleString()} unread emails were found. Remaining emails stay in your inboxes.` : " Nothing has been marked as read."}`;
    render();
    if (!batch.messages.length) { $("briefing").textContent = "A quiet inbox. There's nothing unread in the accounts you selected."; notify("No unread emails to send.", "success"); return; }
    notify("Preparing your briefing on the homeserver…");
    const submitted = await apiRequest(run.settings, "/v1/jobs", {method: "POST", body: {language: run.settings.language || "en", messages: batch.messages}, signal});
    if (!validJobId(submitted.id) || submitted.status !== "queued") throw new MailHarborError("invalid_response", "The server returned an unexpected job response.");
    run.id = submitted.id; await trackJob(run);
    if (currentRun !== runNumber || signal.aborted) { await cancelRun(run); return; }
    jobId = submitted.id;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await sleep(1800, signal);
      const job = await apiRequest(run.settings, `/v1/jobs/${run.id}`, {signal});
      if (currentRun !== runNumber) return;
      if (job.id !== jobId || !["queued", "running", "completed", "failed", "cancelled"].includes(job.status)) throw new MailHarborError("invalid_response", "The server returned an unexpected job state.");
      if (job.status === "completed") {
        result = validateResult(job.result, batch.messages);
        const tab = await tabReady;
        await messenger.runtime.sendMessage({type: "mailharbor-job-release", tabId: tab.id, id: run.id});
        $("briefing").textContent = result.briefing;
        notify("Your briefing is ready. Review the suggestions, then choose which emails to change.", "success");
        render(); return;
      }
      if (job.status === "failed") {
        const errors = {login_required: "Agy needs a manual login on the homeserver.", quota_exhausted: "Google quota is exhausted. Retry after the quota resets.", timeout: "The analysis timed out. You can try a fresh briefing later.", invalid_model_output: "The model's answer did not pass validation. Your emails were not changed.", configuration_error: "The homeserver needs configuration. Check its local setup."};
        throw new MailHarborError(job.error?.code || "provider_error", errors[job.error?.code] || "The homeserver could not complete this briefing. Your emails were not changed.");
      }
      if (job.status === "cancelled") throw new MailHarborError("cancelled", "The briefing was cancelled.");
      notify(job.status === "queued" ? "Queued on your homeserver…" : "Gemini is reading your selected email text…");
    }
    throw new MailHarborError("timeout", "The briefing took too long. Cancel it and try again later.");
  } catch (error) {
    await cancelRun(run).catch(() => {});
    if (currentRun !== runNumber) return;
    $("briefing").textContent = "Your briefing is not ready. Your mailboxes have not been changed.";
    notify(error instanceof MailHarborError ? error.message : "The briefing could not be completed. Check your connection and try again.", "error");
  } finally {
    if (currentRun === runNumber) { jobId = undefined; activeRun = undefined; setBusy(false); if (batch) render(); }
  }
}
$("scan").addEventListener("click", run);
$("cancel").addEventListener("click", cancelActiveRun);
$("settings").addEventListener("click", () => messenger.runtime.openOptionsPage());
async function applySelected(action) {
  const ids = [...selected]; if (!ids.length || busy) return;
  setBusy(true); $("cancel").hidden = true;
  let done = 0, failed = 0;
  try {
    for (const id of ids) {
      try { await session.apply(id, action); done++; statuses.set(id, action === "archive" ? "Archived using this account's Thunderbird settings." : "Marked as read."); }
      catch (error) { failed++; statuses.set(id, error instanceof MailHarborError ? error.message : "Could not change this email. Check the original and scan again."); }
      selected.delete(id);
    }
    notify(`${done} email${done === 1 ? "" : "s"} ${action === "archive" ? "archived" : "marked as read"}.${failed ? ` ${failed} could not be changed; see the notes below.` : ""}`, failed ? "error" : "success");
  } finally { setBusy(false); render(); }
}
$("archive").addEventListener("click", () => applySelected("archive"));
$("mark-read").addEventListener("click", () => applySelected("markRead"));

// Speech runs in this visible extension document and uses only locally installed voices.
const synth = globalThis.speechSynthesis;
let voices = [], speechGeneration = 0;
function loadVoices() {
  const prior = $("voice").value;
  voices = synth && globalThis.SpeechSynthesisUtterance ? synth.getVoices().filter(voice => voice.localService) : [];
  $("voice").replaceChildren();
  for (const voice of voices) { const option = make("option", `${voice.name} · ${voice.lang}`); option.value = voice.voiceURI; $("voice").append(option); }
  if (voices.some(v => v.voiceURI === prior)) $("voice").value = prior;
  else { const preferred = voices.find(v => v.lang.startsWith(settings.language || "en")) || voices.find(v => v.default); if (preferred) $("voice").value = preferred.voiceURI; }
  $("speech-status").textContent = voices.length ? "Ready · installed voices keep audio processing on this device." : "No local voice is available. Install a system speech voice and restart Thunderbird, or use your screen reader to read the briefing.";
  $("voice").disabled = !voices.length; $("speed").disabled = !voices.length;
  if (batch) render(); else updateActions();
}
function stopSpeech() {
  speechGeneration++; synth?.cancel();
  $("pause").disabled = true; $("resume").disabled = true; $("stop").disabled = true;
}
function speak(text, label) {
  if (!voices.length) return;
  stopSpeech();
  const generation = speechGeneration;
  const chunks = text.match(/[\s\S]{1,500}(?:\s|$)|[\s\S]{1,500}/g) || [];
  let index = 0;
  function next() {
    if (generation !== speechGeneration) return;
    if (index >= chunks.length) { $("speech-status").textContent = "Finished listening. Email read status is unchanged."; stopSpeech(); return; }
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    utterance.voice = voices.find(v => v.voiceURI === $("voice").value) || voices[0];
    utterance.lang = utterance.voice.lang; utterance.rate = Number($("speed").value);
    utterance.onstart = () => { if (generation === speechGeneration) $("speech-status").textContent = `${label} · ${index} of ${chunks.length}`; };
    utterance.onend = next;
    utterance.onerror = () => { if (generation === speechGeneration) { stopSpeech(); $("speech-status").textContent = "The voice could not play. Try another installed voice or your screen reader."; } };
    synth.speak(utterance);
  }
  $("pause").disabled = false; $("stop").disabled = false;
  next();
}
$("play").addEventListener("click", () => speak(result?.briefing || "", "Playing briefing"));
$("stop").addEventListener("click", () => { stopSpeech(); $("speech-status").textContent = "Playback stopped."; });
$("pause").addEventListener("click", () => { synth?.pause(); $("pause").disabled = true; $("resume").disabled = false; $("speech-status").textContent = "Paused."; });
$("resume").addEventListener("click", () => { synth?.resume(); $("pause").disabled = false; $("resume").disabled = true; $("speech-status").textContent = "Resuming playback…"; });
$("speed").addEventListener("input", () => { $("speed-value").value = `${Number($("speed").value).toFixed(1)}×`; });
synth?.addEventListener("voiceschanged", loadVoices);
window.addEventListener("pagehide", () => { cancelActiveRun(); session.clear(); stopSpeech(); });
messenger.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  cancelActiveRun(); runNumber++; session.clear(); selected.clear(); batch = undefined; result = undefined;
  settings = changes.settings.newValue || {}; setBusy(false); stopSpeech();
  $("connection").textContent = settings.origin ? "Homeserver paired" : "Setup needed";
  $("briefing").textContent = "Settings changed. Create a fresh briefing with your selected accounts.";
  $("emails").replaceChildren(); $("count").textContent = "Scan again";
  notify("Your connection or accounts changed. Previous review actions were cleared.");
});
async function init() {
  settings = (await messenger.storage.local.get("settings")).settings || {};
  $("connection").textContent = settings.origin ? "Homeserver paired" : "Setup needed";
  if (!settings.origin || !settings.accountIds?.length) notify("Start with Connection & accounts to pair your homeserver and choose your inboxes.");
  loadVoices();
}
init().catch(() => notify("Unable to load settings. Reopen MailHarbor or check the add-on permissions.", "error"));
