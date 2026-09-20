import {apiRequest, normalizeOrigin, validJobId} from "./core.mjs";

// Pending job handles survive an MV3 background-page suspension, but not a Thunderbird restart.
// Only endpoint credentials and opaque job IDs are held here; no message bodies or summaries.
export class JobTracker {
  constructor(storage, request = apiRequest) { this.storage = storage; this.request = request; this.queue = Promise.resolve(); }
  serialize(task) { const next = this.queue.then(task, task); this.queue = next.catch(() => {}); return next; }
  async read() { return (await this.storage.get("pendingJobs")).pendingJobs || {}; }
  register(tabId, id, settings) {
    return this.serialize(async () => {
      if (!Number.isInteger(tabId) || !validJobId(id)) throw new Error("Invalid job handle.");
      const origin = normalizeOrigin(settings.origin);
      const jobs = await this.read();
      jobs[tabId] = {id, settings: {origin, token: settings.token}};
      await this.storage.set({pendingJobs: jobs});
    });
  }
  release(tabId, id) {
    return this.serialize(async () => {
      const jobs = await this.read();
      if (jobs[tabId]?.id === id) { delete jobs[tabId]; await this.storage.set({pendingJobs: jobs}); }
    });
  }
  cancel(tabId, expectedId) {
    return this.serialize(async () => {
      const jobs = await this.read(), job = jobs[tabId];
      if (!job || (expectedId && job.id !== expectedId)) return false;
      // Capture the original endpoint and credentials before settings may be replaced.
      delete jobs[tabId]; await this.storage.set({pendingJobs: jobs});
      try { await this.request(job.settings, `/v1/jobs/${job.id}`, {method: "DELETE"}); return true; }
      catch { return false; }
    });
  }
  async cancelAll() { const jobs = await this.read(); await Promise.all(Object.keys(jobs).map(tabId => this.cancel(tabId))); }
}
