import {apiRequest, normalizeOrigin, originPattern} from "./core.mjs";
const $ = id => document.getElementById(id);
let saved = {};
const notify = (message, error = false) => { $("notice").textContent = message; $("notice").className = `notice ${error ? "error" : "success"}`; };
async function init() {
  saved = (await messenger.storage.local.get("settings")).settings || {};
  $("origin").value = saved.origin || "";
  $("language").value = saved.language || "en";
  if (saved.token) { $("token").placeholder = "Token saved · leave blank to keep it"; $("token-hint").textContent = "A token is saved locally. Enter a new one to replace it."; }
  const accounts = await messenger.accounts.list(false);
  $("accounts").replaceChildren();
  for (const account of accounts.filter(a => ["imap", "pop3", "exchange", "ews"].includes(a.type))) {
    const label = document.createElement("label"); label.className = "account-choice";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = account.id; input.checked = saved.accountIds?.includes(account.id) || false;
    const text = document.createElement("span"); text.textContent = account.name;
    const small = document.createElement("small"); small.textContent = account.type === "pop3" ? "POP · changes may remain local" : account.type.toUpperCase();
    text.append(small); label.append(input, text); $("accounts").append(label);
  }
  if (!$("accounts").children.length) $("accounts").textContent = "Add your email accounts to Thunderbird first, then reopen Settings.";
}
$("form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const origin = normalizeOrigin($("origin").value);
    const token = $("token").value.trim() || (origin === saved.origin ? saved.token : "");
    if (!token || token.length > 2048 || /[\r\n]/.test(token)) throw new Error("Enter the pairing token for this server.");
    const accountIds = [...$("accounts").querySelectorAll("input:checked")].map(input => input.value);
    if (!accountIds.length) throw new Error("Choose at least one email account.");
    // Called directly from the submit gesture, before other awaits, so the permission prompt is valid.
    const granted = await messenger.permissions.request({origins: [originPattern(origin)]});
    if (!granted) throw new Error("Server access was not granted. Your settings were not changed.");
    const oldOrigin = saved.origin;
    saved = {origin, token, accountIds, language: $("language").value};
    await messenger.storage.local.set({settings: saved});
    $("token").value = ""; $("token").placeholder = "Token saved · leave blank to keep it";
    $("token-hint").textContent = "A token is saved locally. Enter a new one to replace it.";
    if (oldOrigin && originPattern(oldOrigin) !== originPattern(origin)) await messenger.permissions.remove({origins: [originPattern(oldOrigin)]});
    notify("Saved. Open the dashboard to create your first briefing.");
  } catch (error) { notify(error.message, true); }
});
$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  try {
    if (!saved.origin || !saved.token) throw new Error("Save your connection before checking it.");
    const result = await apiRequest(saved, "/v1/status");
    if (typeof result.ready !== "boolean" || typeof result.model !== "string") throw new Error("The server returned an unexpected status.");
    notify(result.ready ? `Connected. Local profile configured for ${result.model}. Google sign-in and quota are checked when you request a briefing.` : "Connected, but Agy is not ready. Check the homeserver's local setup.", !result.ready);
  } catch (error) { notify(error.message, true); } finally { $("test").disabled = false; }
});
init().catch(() => notify("Unable to load settings. Check the add-on's account permissions.", true));
