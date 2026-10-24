import { explainFetchFailure } from './net.js';
import { t } from './i18n.js';

// Xtream Codes client. Item shape shared with m3u.js: { id, name, logo, group, url }
// plus `kind` ('movie' | 'series' | 'episode') for non-live content.

const enc = encodeURIComponent;

export const normalizeServer = (server) =>
  (/^https?:\/\//i.test(server) ? server : `http://${server}`).replace(/\/+$/, '');

function api(src, action = '', extra = '') {
  const q = `username=${enc(src.user)}&password=${enc(src.pass)}`;
  return `${normalizeServer(src.server)}/player_api.php?${q}${action ? `&action=${action}` : ''}${extra}`;
}

function mediaUrl(src, folder, id, ext) {
  return `${normalizeServer(src.server)}/${folder}/${enc(src.user)}/${enc(src.pass)}/${id}.${ext}`;
}

async function getJSON(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(await explainFetchFailure(url));
  }
  if (!res.ok) throw new Error(t('err.server', { code: res.status }));
  try {
    return await res.json();
  } catch {
    throw new Error(t('err.badReply'));
  }
}

const categoryNames = (cats) =>
  new Map((Array.isArray(cats) ? cats : []).map((c) => [String(c.category_id), c.category_name]));

const asList = (v) => (Array.isArray(v) ? v : []);

export async function login(src) {
  const info = await getJSON(api(src));
  if (!info.user_info || Number(info.user_info.auth) === 0) throw new Error(t('err.login'));
  return info;
}

export async function fetchLive(src) {
  const [cats, streams] = await Promise.all([
    getJSON(api(src, 'get_live_categories')),
    getJSON(api(src, 'get_live_streams')),
  ]);
  const names = categoryNames(cats);
  const channels = asList(streams).map((s) => ({
    id: String(s.stream_id),
    name: s.name,
    logo: s.stream_icon || '',
    group: names.get(String(s.category_id)) || t('group.other'),
    url: mediaUrl(src, 'live', s.stream_id, 'm3u8'),
  }));
  if (!channels.length) throw new Error(t('err.noChannels'));
  return channels;
}

export async function fetchMovies(src) {
  const [cats, streams] = await Promise.all([
    getJSON(api(src, 'get_vod_categories')),
    getJSON(api(src, 'get_vod_streams')),
  ]);
  const names = categoryNames(cats);
  const movies = asList(streams).map((s) => {
    const ext = s.container_extension || 'mp4';
    return {
      kind: 'movie',
      id: String(s.stream_id),
      name: s.name,
      logo: s.stream_icon || '',
      group: names.get(String(s.category_id)) || t('group.other'),
      rating: s.rating,
      url: mediaUrl(src, 'movie', s.stream_id, ext),
    };
  });
  if (!movies.length) throw new Error(t('err.noMovies'));
  return movies;
}

export async function fetchSeriesList(src) {
  const [cats, list] = await Promise.all([
    getJSON(api(src, 'get_series_categories')),
    getJSON(api(src, 'get_series')),
  ]);
  const names = categoryNames(cats);
  const series = asList(list).map((s) => ({
    kind: 'series',
    id: String(s.series_id),
    name: s.name,
    logo: s.cover || '',
    group: names.get(String(s.category_id)) || t('group.other'),
    plot: s.plot || '',
    rating: s.rating,
    genre: s.genre || '',
    year: String(s.releaseDate || s.release_date || '').slice(0, 4),
  }));
  if (!series.length) throw new Error(t('err.noSeries'));
  return series;
}

// -> [{ number, name, episodes: [{ kind:'episode', id, name, plot, duration, logo, url }] }]
export async function fetchSeriesInfo(src, seriesId) {
  const data = await getJSON(api(src, 'get_series_info', `&series_id=${enc(seriesId)}`));
  const raw = data.episodes || {};
  const all = Array.isArray(raw) ? raw.flat() : Object.values(raw).flat();
  const bySeason = new Map();
  for (const e of all) {
    const n = Number(e.season) || 1;
    if (!bySeason.has(n)) bySeason.set(n, []);
    const ext = e.container_extension || 'mp4';
    const info = e.info || {};
    bySeason.get(n).push({
      kind: 'episode',
      id: String(e.id),
      num: Number(e.episode_num) || 0,
      name: `${e.episode_num}. ${e.title || t('episode')}`,
      plot: info.plot || '',
      duration: info.duration || '',
      logo: info.movie_image || '',
      url: mediaUrl(src, 'series', e.id, ext),
    });
  }
  return [...bySeason.keys()].sort((a, b) => a - b).map((n) => ({
    number: n,
    name: t('season', { n }),
    episodes: bySeason.get(n).sort((a, b) => a.num - b.num),
  }));
}

export async function fetchVodInfo(src, vodId) {
  const data = await getJSON(api(src, 'get_vod_info', `&vod_id=${enc(vodId)}`));
  const i = data.info || {};
  return {
    plot: i.plot || i.description || '',
    genre: i.genre || '',
    duration: i.duration || '',
    year: String(i.releasedate || i.releaseDate || '').slice(0, 4),
    rating: i.rating || '',
  };
}
