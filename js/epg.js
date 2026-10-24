import { t } from './i18n.js';

// Now/next lookup. Xtream: per-channel short EPG. M3U: XMLTV from the playlist's url-tvg.
// Result: { now: {title,start,stop}|null, next: {title,start,stop}|null }  (times in unix seconds)

const TTL = 2 * 60 * 1000;
const cache = new Map();
let src = null;
let xmltv = null; // Promise<Map<channelId, programme[]>>

export function configureEpg(source, epgUrl) {
  src = { source, epgUrl };
  cache.clear();
  xmltv = null;
}

const b64 = (s) => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return s; }
};

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function pick(list) {
  const now = Date.now() / 1000;
  const sorted = list.filter((p) => p.stop > now).sort((a, b) => a.start - b.start);
  const cur = sorted.find((p) => p.start <= now) || null;
  const next = sorted.find((p) => p.start > now) || null;
  return { now: cur, next };
}

async function xtreamEpg(ch) {
  const { server, user, pass } = src.source;
  const base = server.replace(/\/+$/, '');
  const url = `${base}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_short_epg&stream_id=${encodeURIComponent(ch.id)}&limit=4`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('err.epg'));
  const data = await res.json();
  return pick((data.epg_listings || []).map((l) => ({
    title: b64(l.title), start: +l.start_timestamp, stop: +l.stop_timestamp,
  })));
}

function xmlTime(t) {
  const m = t.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/);
  if (!m) return NaN;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const off = m[7] ? (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000 : 0;
  return (ms - off) / 1000;
}

async function loadXmltv(url) {
  let res = await fetch(url);
  if (!res.ok) throw new Error(t('err.xmltv'));
  let text;
  if (/\.gz(\?|$)/i.test(url)) {
    if (!window.DecompressionStream) throw new Error(t('err.gz'));
    text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  } else {
    text = await res.text();
  }
  const now = Date.now() / 1000, horizon = now + 12 * 3600;
  const map = new Map();
  for (const m of text.matchAll(/<programme\s+start="([^"]+)"\s+stop="([^"]+)"\s+channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/g)) {
    const start = xmlTime(m[1]), stop = xmlTime(m[2]);
    if (!(stop > now && start < horizon)) continue;
    const t = m[4].match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const key = m[3].toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ title: t ? unescapeXml(t[1].trim()) : '', start, stop });
  }
  return map;
}

async function xmltvEpg(ch) {
  if (!src.epgUrl) return { now: null, next: null };
  xmltv ||= loadXmltv(src.epgUrl).catch((e) => { xmltv = null; throw e; });
  const map = await xmltv;
  return pick(map.get(String(ch.id).toLowerCase()) || []);
}

export async function nowNext(ch) {
  const none = { now: null, next: null };
  if (!src) return none;
  const hit = cache.get(ch.id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const value = src.source.type === 'xtream' ? await xtreamEpg(ch) : await xmltvEpg(ch);
    cache.set(ch.id, { at: Date.now(), value });
    return value;
  } catch {
    return none;
  }
}
