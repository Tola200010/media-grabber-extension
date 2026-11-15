// Minimal HLS playlist parsing (RFC 8216 subset): master/media playlists, EXT-X-MAP, AES-128.
export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Not an HLS playlist");
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const a = parseAttrs(lines[i].slice(18));
        variants.push({ bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || "", url: abs(lines[i + 1]) });
      }
    }
    return { master: true, variants };
  }

  const segments = [];
  let key = null;
  let map = null;
  let seq = 0;
  for (const l of lines) {
    if (l.startsWith("#EXT-X-BYTERANGE")) throw new Error("HLS byte-range segments are not supported");
    else if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = Number(l.split(":")[1]) || 0;
    else if (l.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === "NONE" ? null : { method: a.METHOD, uri: a.URI && abs(a.URI), iv: a.IV };
    } else if (l.startsWith("#EXT-X-MAP:")) map = abs(parseAttrs(l.slice(11)).URI);
    else if (!l.startsWith("#")) segments.push({ url: abs(l), seq: seq++, key });
  }
  return { master: false, segments, map };
}
