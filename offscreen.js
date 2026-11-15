import { parsePlaylist } from "./hls.js";
import { parseMpd, best } from "./dash.js";

const CONCURRENCY = 6;

// Fetch with cookies and up to 3 attempts (CDNs often drop the odd segment request).
async function fetchOk(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} for ${url}`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break; // not worth retrying
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  throw last;
}
const getText = async (url) => (await fetchOk(url)).text();
const getBuf = async (url) => (await fetchOk(url)).arrayBuffer();

function ivBytes(seg) {
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, "").padStart(32, "0");
    return Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  }
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seg.seq);
  return iv;
}

async function runHls(jobId, url) {
  const send = (m) => chrome.runtime.sendMessage({ jobId, ...m });
  try {
    let pl = parsePlaylist(await getText(url), url);
    if (pl.master) {
      const best = pl.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
      pl = parsePlaylist(await getText(best.url), best.url);
    }
    const segs = pl.segments;
    if (!segs.length) throw new Error("Playlist has no segments");
    if (segs.some((s) => s.key && s.key.method !== "AES-128")) {
      throw new Error("Stream uses an unsupported encryption method (only none or AES-128).");
    }

    const keys = new Map();
    const getKey = (uri) => {
      if (!keys.has(uri)) {
        keys.set(uri, getBuf(uri).then((raw) => crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])));
      }
      return keys.get(uri);
    };

    const parts = new Array(segs.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < segs.length) {
        const i = next++;
        const s = segs[i];
        let data = await getBuf(s.url);
        if (s.key) data = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes(s) }, await getKey(s.key.uri), data);
        parts[i] = data;
        send({ cmd: "progress", done: ++done, total: segs.length });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const fmp4 = !!pl.map;
    const blobParts = fmp4 ? [await getBuf(pl.map), ...parts] : parts;
    const blob = new Blob(blobParts, { type: fmp4 ? "video/mp4" : "video/mp2t" });
    send({ cmd: "file-done", url, ext: fmp4 ? "mp4" : "ts", suffix: "", blobUrl: URL.createObjectURL(blob) });
  } catch (e) {
    send({ cmd: "job-error", error: String((e && e.message) || e) });
  }
}

// DASH: video and audio are separate tracks; we save each as fragmented MP4 (no muxing without ffmpeg).
async function runDash(jobId, url) {
  const send = (m) => chrome.runtime.sendMessage({ jobId, ...m });
  try {
    const doc = new DOMParser().parseFromString(await getText(url), "text/xml");
    const mpd = parseMpd(doc, url);
    const tracks = [
      ["video", best(mpd.video), "mp4", ".video"],
      ["audio", best(mpd.audio), "m4a", ".audio"],
    ].filter((t) => t[1]);
    if (!tracks.length) throw new Error("No downloadable tracks in manifest");
    const total = tracks.reduce((n, t) => n + t[1].segments.length + (t[1].init ? 1 : 0), 0);
    let done = 0;
    for (const [, rep, ext, suffix] of tracks) {
      const urls = [...(rep.init ? [rep.init] : []), ...rep.segments];
      const parts = new Array(urls.length);
      let next = 0;
      const worker = async () => {
        while (next < urls.length) {
          const i = next++;
          parts[i] = await getBuf(urls[i]);
          send({ cmd: "progress", done: ++done, total });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      const blob = new Blob(parts, { type: rep.mime });
      send({ cmd: "file-done", url, ext, suffix, blobUrl: URL.createObjectURL(blob) });
    }
  } catch (e) {
    send({ cmd: "job-error", error: String((e && e.message) || e) });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.cmd === "hls") runHls(msg.jobId, msg.url);
  else if (msg.cmd === "dash") runDash(msg.jobId, msg.url);
});
