const LISTS_KEY = 'tvip.playlists';
const ACTIVE_KEY = 'tvip.active';
const OLD_SOURCE_KEY = 'tvip.source';
const favKey = (id) => `tvip.favs.${id}`;

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// Playlist: { id, name, type: 'm3u'|'xtream', url | server, user, pass }
export function loadPlaylists() {
  const lists = read(LISTS_KEY);
  if (Array.isArray(lists)) return lists;
  const old = read(OLD_SOURCE_KEY);   // single-source versions
  if (old) {
    const migrated = [{ id: 'default', name: 'Listem', ...old }];
    const oldFavs = read('tvip.favs');
    if (oldFavs) write(favKey('default'), oldFavs);
    savePlaylists(migrated);
    saveActive('default');
    return migrated;
  }
  return [];
}

export const savePlaylists = (lists) => write(LISTS_KEY, lists);
export const loadActive = () => read(ACTIVE_KEY);
export const saveActive = (id) => write(ACTIVE_KEY, id);

export function loadFavs(id) {
  const v = read(favKey(id));
  return new Set(Array.isArray(v) ? v : []);
}

export function saveFavs(id, set) {
  write(favKey(id), [...set]);
}

export function deleteFavs(id) {
  try { localStorage.removeItem(favKey(id)); } catch { /* storage unavailable */ }
}

// Saved VOD playback positions: { "movie:12": { t, d, at } }
const posKey = (id) => `tvip.pos.${id}`;

export function loadPos(id) {
  const v = read(posKey(id));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function savePos(id, map) {
  const keys = Object.keys(map);
  if (keys.length > 300) {
    keys.sort((a, b) => map[a].at - map[b].at).slice(0, keys.length - 300).forEach((k) => delete map[k]);
  }
  write(posKey(id), map);
}

export function deletePos(id) {
  try { localStorage.removeItem(posKey(id)); } catch { /* storage unavailable */ }
}

// Recently watched (live channels, movies, episodes) per playlist, newest first.
const recentKey = (id) => `tvip.recent.${id}`;

export function loadRecent(id) {
  const v = read(recentKey(id));
  return Array.isArray(v) ? v : [];
}

export function saveRecent(id, list) {
  write(recentKey(id), list);
}

export function deleteRecent(id) {
  try { localStorage.removeItem(recentKey(id)); } catch { /* storage unavailable */ }
}
