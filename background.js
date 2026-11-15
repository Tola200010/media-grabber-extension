// Media Grabber service worker: sniff media requests per tab, serve list to popup, run downloads.
const DIRECT_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|mp3|m4a|aac|ogg|opus|wav)(?:$|[?#])/i;
const HLS_EXT = /\.m3u8(?:$|[?#])/i;
const DASH_EXT = /\.mpd(?:$|[?#])/i;
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa)(?:$|[?#])/i;
const MIN_DIRECT_BYTES = 100 * 1024; // ignore tiny clips/pings

const key = (tabId) => `tab:${tabId}`;

async function getItems(tabId) {
  const r = await chrome.storage.session.get(key(tabId));
  return r[key(tabId)] || [];
}

async function setItems(tabId, items) {
  await chrome.storage.session.set({ [key(tabId)]: items });
  const n = items.length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2b7de9" });
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function classify(url, mime) {
  const m = mime.toLowerCase();
  if (HLS_EXT.test(url) || m.includes("mpegurl")) return "hls";
  if (DASH_EXT.test(url) || m.includes("dash+xml")) return "dash";
  if (SEGMENT_EXT.test(url) || m === "video/mp2t") return null; // segments are not items
  if (m.startsWith("video/") || m.startsWith("audio/") || DIRECT_EXT.test(url)) return "direct";
  return null;
}

function totalSize(d) {
  const range = header(d.responseHeaders, "content-range"); // bytes 0-1/12345
  const mm = /\/(\d+)$/.exec(range);
  if (mm) return Number(mm[1]);
  return Number(header(d.responseHeaders, "content-length")) || 0;
}

// Remember Referer/Origin the page used for each request, so we can replay them when downloading
// (many CDNs answer 403 to requests without them).
const reqHeaders = new Map(); // requestId -> {referer, origin}
chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const get = (n) => (d.requestHeaders.find((h) => h.name.toLowerCase() === n) || {}).value || "";
    reqHeaders.set(d.requestId, { referer: get("referer"), origin: get("origin") });
    if (reqHeaders.size > 500) reqHeaders.delete(reqHeaders.keys().next().value);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["requestHeaders", "extraHeaders"]
);

const queues = new Map(); // tabId -> promise chain, so read-modify-write on a tab's list never interleaves
const enqueue = (tabId, fn) => {
  const next = (queues.get(tabId) || Promise.resolve()).then(fn, fn).catch(() => {});
  queues.set(tabId, next);
  return next;
};

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const mime = header(d.responseHeaders, "content-type").split(";")[0].trim();
    const type = classify(d.url, mime);
    if (!type) return;
    const size = totalSize(d);
    if (type === "direct" && size && size < MIN_DIRECT_BYTES) return;
    const hdrs = reqHeaders.get(d.requestId) || {};
    reqHeaders.delete(d.requestId);
    enqueue(d.tabId, async () => {
      const items = await getItems(d.tabId);
      const id = d.url.split("#")[0];
      if (items.some((i) => i.url === id)) return;
      let title = "";
      let pageUrl = "";
      try {
        const tab = await chrome.tabs.get(d.tabId);
        title = tab.title || "";
        pageUrl = tab.url || "";
      } catch {}
      items.push({
        url: id, type, mime, size, title, ts: Date.now(),
        referer: hdrs.referer || pageUrl,
        origin: hdrs.origin || (pageUrl ? new URL(pageUrl).origin : ""),
      });
      await setItems(d.tabId, items);
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Reset list on top-level navigation.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) enqueue(tabId, () => setItems(tabId, []));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

function safeName(s, fallback) {
  const n = (s || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 120);
  return n || fallback;
}

function fileNameFor(item, ext, suffix = "") {
  let base = "";
  try {
    base = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || "");
  } catch {}
  base = base.replace(/\.[a-z0-9]+$/i, "");
  return safeName(item.title || base, "media") + suffix + "." + ext;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Assemble HLS segments into a single file for download",
  });
}

// Header rules: requests made by the extension itself (tabId -1) get the original Referer/Origin.
let ruleSeq = 1000;
async function addHeaderRule(item) {
  if (!item.referer && !item.origin) return 0;
  const id = ++ruleSeq;
  const requestHeaders = [];
  if (item.referer) requestHeaders.push({ header: "referer", operation: "set", value: item.referer });
  if (item.origin) requestHeaders.push({ header: "origin", operation: "set", value: item.origin });
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id, priority: 1,
      action: { type: "modifyHeaders", requestHeaders },
      condition: { tabIds: [-1], resourceTypes: ["xmlhttprequest", "media", "other"] },
    }],
  });
  return id;
}
const removeHeaderRule = (id) => id && chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
const downloadRules = new Map(); // downloadId -> ruleId
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current !== "in_progress" && downloadRules.has(delta.id)) {
    removeHeaderRule(downloadRules.get(delta.id));
    downloadRules.delete(delta.id);
  }
});

// jobId -> {state, done, total, url, error}; mirrored to session storage so a worker restart keeps them.
let jobs = {};
const jobsReady = chrome.storage.session.get("jobs").then((r) => {
  jobs = { ...(r.jobs || {}), ...jobs };
});
let saveTimer = null;
const saveJobs = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ jobs }), 300);
};

async function startDownload(item) {
  if (item.type === "direct") {
    const m = DIRECT_EXT.exec(item.url);
    const ext = m ? m[1] : (item.mime.split("/")[1] || "mp4").replace(/[^a-z0-9].*/i, "") || "mp4";
    const rule = await addHeaderRule(item);
    try {
      const dlId = await chrome.downloads.download({ url: item.url, filename: fileNameFor(item, ext), saveAs: false });
      if (rule) downloadRules.set(dlId, rule);
    } catch (e) {
      removeHeaderRule(rule);
      return { ok: false, error: String(e.message || e) };
    }
    return { ok: true };
  }
  if (item.type === "hls" || item.type === "dash") {
    await ensureOffscreen();
    const jobId = crypto.randomUUID();
    await jobsReady;
    jobs[jobId] = { state: "running", done: 0, total: 0, url: item.url, title: item.title, rule: await addHeaderRule(item) };
    saveJobs();
    chrome.runtime.sendMessage({ target: "offscreen", cmd: item.type, jobId, url: item.url });
    return { ok: true, jobId };
  }
  return { ok: false, error: "Unsupported item type" };
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.target === "offscreen") return;
  (async () => {
    await jobsReady;
    switch (msg.cmd) {
      case "list":
        return send(await getItems(msg.tabId));
      case "clear":
        await setItems(msg.tabId, []);
        return send(true);
      case "download":
        return send(await startDownload(msg.item));
      case "jobs":
        return send(jobs);
      // from the offscreen document:
      case "progress":
        Object.assign((jobs[msg.jobId] ||= {}), { done: msg.done, total: msg.total });
        if (msg.done >= msg.total) {
          removeHeaderRule(jobs[msg.jobId].rule);
          jobs[msg.jobId].rule = 0;
        }
        saveJobs();
        return send(true);
      case "job-error":
        removeHeaderRule((jobs[msg.jobId] || {}).rule);
        Object.assign((jobs[msg.jobId] ||= {}), { state: "error", error: msg.error });
        saveJobs();
        return send(true);
      case "file-done": {
        const job = (jobs[msg.jobId] ||= {});
        job.files = (job.files || 0) + 1;
        job.state = "done";
        saveJobs();
        await chrome.downloads.download({
          url: msg.blobUrl,
          filename: fileNameFor({ url: msg.url, title: job.title || "" }, msg.ext, msg.suffix),
          saveAs: false,
        });
        return send(true);
      }
    }
  })();
  return true;
});
