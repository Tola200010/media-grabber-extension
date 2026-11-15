// Minimal MPEG-DASH (static MPD) parsing: SegmentTemplate (+Timeline), SegmentList, single BaseURL.
// Takes an already-parsed XML Document so it works with DOMParser (offscreen) or a test DOM.

const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
const kid = (el, name) => kids(el, name)[0] || null;

export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(iso || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function expand(tpl, vars) {
  return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (_, name, width) => {
    if (name === "") return "$";
    if (!(name in vars)) return `$${name}$`;
    const v = String(vars[name]);
    return width ? v.padStart(Number(width), "0") : v;
  });
}

// Walk up Representation -> AdaptationSet -> Period for the nearest element of this name.
const inherited = (chain, name) => {
  for (const el of chain) {
    const k = kid(el, name);
    if (k) return k;
  }
  return null;
};

function buildSegments(rep, chain, baseUrl, periodDuration) {
  const vars = { RepresentationID: rep.getAttribute("id") || "", Bandwidth: rep.getAttribute("bandwidth") || "0" };
  const abs = (u) => new URL(u, baseUrl).href;

  const tpl = inherited(chain, "SegmentTemplate");
  if (tpl) {
    const ts = Number(tpl.getAttribute("timescale")) || 1;
    const start = tpl.hasAttribute("startNumber") ? Number(tpl.getAttribute("startNumber")) : 1;
    const initT = tpl.getAttribute("initialization");
    const media = tpl.getAttribute("media");
    const init = initT ? abs(expand(initT, vars)) : null;
    const segments = [];
    const tl = kid(tpl, "SegmentTimeline");
    if (tl) {
      let t = 0;
      let n = start;
      for (const s of kids(tl, "S")) {
        if (s.hasAttribute("t")) t = Number(s.getAttribute("t"));
        const d = Number(s.getAttribute("d"));
        const r = Number(s.getAttribute("r") || 0);
        if (r < 0) throw new Error("Open-ended repeat in timeline (live stream?) is not supported");
        for (let i = 0; i <= r; i++) {
          segments.push(abs(expand(media, { ...vars, Number: n++, Time: t })));
          t += d;
        }
      }
    } else {
      const d = Number(tpl.getAttribute("duration"));
      if (!d || !periodDuration) throw new Error("Cannot determine segment count");
      const count = Math.ceil((periodDuration * ts) / d);
      for (let i = 0; i < count; i++) segments.push(abs(expand(media, { ...vars, Number: start + i, Time: i * d })));
    }
    return { init, segments };
  }

  const list = inherited(chain, "SegmentList");
  if (list) {
    const initEl = kid(list, "Initialization");
    return {
      init: initEl ? abs(initEl.getAttribute("sourceURL")) : null,
      segments: kids(list, "SegmentURL").map((s) => abs(s.getAttribute("media"))),
    };
  }

  return { init: null, segments: [baseUrl] }; // plain BaseURL: one file
}

export function parseMpd(doc, mpdUrl) {
  const mpd = doc.documentElement;
  if (mpd.localName !== "MPD") throw new Error("Not a DASH manifest");
  if (mpd.getAttribute("type") === "dynamic") throw new Error("Live DASH streams are not supported");
  const periods = kids(mpd, "Period");
  if (periods.length !== 1) throw new Error(`Multi-period DASH (${periods.length} periods) is not supported`);
  const period = periods[0];
  const periodDuration = parseDuration(period.getAttribute("duration") || mpd.getAttribute("mediaPresentationDuration"));

  const baseOf = (parent, el) => {
    const b = kid(el, "BaseURL");
    return b ? new URL(b.textContent.trim(), parent).href : parent;
  };
  const mpdBase = baseOf(mpdUrl, mpd);
  const periodBase = baseOf(mpdBase, period);

  const out = { video: [], audio: [] };
  for (const set of kids(period, "AdaptationSet")) {
    const setBase = baseOf(periodBase, set);
    for (const rep of kids(set, "Representation")) {
      if (kid(rep, "ContentProtection") || kid(set, "ContentProtection")) {
        throw new Error("DASH stream is DRM-protected (ContentProtection); not supported");
      }
      const mime = rep.getAttribute("mimeType") || set.getAttribute("mimeType") || set.getAttribute("contentType") || "";
      const kind = mime.startsWith("video") ? "video" : mime.startsWith("audio") ? "audio" : null;
      if (!kind) continue;
      const repBase = baseOf(setBase, rep);
      const { init, segments } = buildSegments(rep, [rep, set, period], repBase, periodDuration);
      out[kind].push({
        id: rep.getAttribute("id"),
        bandwidth: Number(rep.getAttribute("bandwidth")) || 0,
        mime,
        codecs: rep.getAttribute("codecs") || set.getAttribute("codecs") || "",
        init,
        segments,
      });
    }
  }
  return out;
}

export const best = (reps) => reps.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
