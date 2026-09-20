let dashboardId;
const trackerReady = import("./lifecycle.mjs").then(({JobTracker}) => new JobTracker(messenger.storage.session));
messenger.action.onClicked.addListener(async () => {
  if (dashboardId !== undefined) {
    try { await messenger.tabs.update(dashboardId, {active: true}); return; }
    catch { dashboardId = undefined; }
  }
  const tab = await messenger.tabs.create({url: "dashboard.html"});
  dashboardId = tab.id;
});
messenger.tabs.onRemoved.addListener(id => {
  if (id === dashboardId) dashboardId = undefined;
  trackerReady.then(tracker => tracker.cancel(id)).catch(() => {});
});
messenger.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== messenger.runtime.id || !message?.type?.startsWith("mailharbor-job-")) return undefined;
  return trackerReady.then(async tracker => {
    if (message.type === "mailharbor-job-track") await tracker.register(message.tabId, message.id, message.settings);
    else if (message.type === "mailharbor-job-cancel") await tracker.cancel(message.tabId, message.id);
    else if (message.type === "mailharbor-job-release") await tracker.release(message.tabId, message.id);
    return {ok: true};
  });
});
messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) trackerReady.then(tracker => tracker.cancelAll()).catch(() => {});
});
