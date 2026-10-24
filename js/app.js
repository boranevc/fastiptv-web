import { KEY, focus, move, items, current } from './nav.js';
import { fetchM3U } from './m3u.js';
import * as xt from './xtream.js';
import * as pl from './player.js';
import { loadPlaylists, savePlaylists, loadActive, saveActive, loadFavs, saveFavs, deleteFavs, loadPos, savePos, deletePos, loadRecent, saveRecent, deleteRecent } from './storage.js';
import { configureEpg, nowNext } from './epg.js';
import { t, locale, applyStatic } from './i18n.js';

const $ = (id) => document.getElementById(id);

// Fit the fixed 1920x1080 stage into any window (letterboxed); on the TV the window is 1920x1080, so the scale is 1.
const stage = $('stage');
function fitStage() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px, ${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
}
fitStage();
addEventListener('resize', fitStage);
const login = $('login'), browser = $('browser'), listsScreen = $('lists'), homeScreen = $('home'), seriesScreen = $('series');
const screens = [login, listsScreen, homeScreen, browser, seriesScreen];
const colCats = $('col-cats'), colChans = $('col-chans');
const list = $('chan-list'), search = $('search');
const colSeasons = $('col-seasons'), colEps = $('col-eps');
const tiles = $('home-tiles');
const video = pl.el;

const SEARCH = 'Ara';
const MAX_RESULTS = 300;
const CHUNK = 150;           // rows rendered at a time in the channel list
const ALL = 'Tümü';
const FAV = '★ Favoriler';   // internal ids of the built-in groups; the shown label comes from groupLabel()
const groupLabel = (g) => (g === ALL ? t('group.all') : g === FAV ? t('group.favorites') : g);
// LG store rule: adult content needs age verification and pornography is prohibited. The app ships no content, and
// hides provider categories/titles that are labelled as adult (best effort, based on the name the provider gives).
const HIDE_ADULT = true;
const ADULT_GROUP = /(^|[^a-z0-9])(xxx|porn|porno|adult|erotic|erotik|sex|seks|hardcore|yeti[sş]kin)([^a-z0-9]|$)|(^|[^0-9])18\s*\+|\+\s*18/i;
const ADULT_NAME = /(^|[^a-z0-9])xxx([^a-z0-9]|$)/i;
const isAdult = (c) => ADULT_GROUP.test(c.group || '') || ADULT_NAME.test(c.name || '');

const sectionName = (name) => t(`section.${name}`);
const BADGES = { live: ['badge.live', 'live'], movie: ['badge.movie', 'tag'], series: ['badge.series', 'tag'], episode: ['badge.episode', 'tag'] };

let playlists = loadPlaylists();
let source = null;           // playlist currently connected
let favs = new Set();
let positions = {};          // saved VOD positions of the connected playlist
let cache = {};              // section -> Promise of items, per connection
let data = {};               // section -> loaded items
let recent = [];             // recently watched, newest first
let rowBtn = -1, delArmed = false;   // focused button inside a playlist row (-1 = the row itself)
let homeIdx = 0;
let loading = false;
let section = 'live';
let allChannels = [];        // items of the open section
let groups = new Map();      // group name -> items
let groupNames = [];
let visible = [];            // items of the selected group / search
let rendered = 0;
let curGroup = ALL;
let playing = null;          // item being played
let playCtx = null;          // { kind: 'live' } | { kind: 'vod', back, episodes, idx, seriesName }
let curSeries = null;        // { item, seasons, flat }
let curSeason = 0;
let view = 'login';          // login | lists | home | cats | search | chans | series | full | tracks
let osdTimer, toastTimer, infoTimer, barTimer, lastSave = 0, lastSeek = 0, seekStreak = 0;
const vodInfo = new Map();
const seriesCache = new Map();

const favId = (c) => (c.kind ? `${c.kind}:${c.id}` : c.id);
const posKey = (c) => `${c.kind}:${c.id}`;

// Hand the Back key to webOS so it returns to the TV Home screen.
function exitApp() {
  const sys = window.webOSSystem || window.PalmSystem;
  if (sys && typeof sys.platformBack === 'function') sys.platformBack(); else window.close();
}

function showScreen(screen) {
  screens.forEach((s) => (s.hidden = s !== screen));
  updateInfo(null);
  favFocus = false;
  $('topbar').hidden = screen === null;
  $('dock').hidden = screen === null;
  setCrumb(screen === browser ? sectionName(section) : screen === seriesScreen ? curSeries?.item.name : '');
  updateStatus();
  renderDock(screen);
}

function setCrumb(text) {
  const c = $('crumb');
  c.textContent = text || '';
  c.hidden = !text;
}

// Active-list pill in the top bar (expiry and connection count are shown when the provider reports them).
function updateStatus() {
  const pill = $('pill');
  pill.hidden = !source || !login.hidden;
  if (pill.hidden) return;
  const m = source.meta || {};
  $('pill-name').textContent = `${source.name} • ${source.type === 'xtream' ? 'Xtream' : 'M3U'}`;
  const hasExp = m.exp > 0, hasConn = !!m.max;
  $('pill-expwrap').hidden = $('pill-sep1').hidden = !hasExp;
  $('pill-conn').hidden = $('pill-sep2').hidden = !hasConn;
  if (hasExp) $('pill-exp').textContent = new Date(m.exp * 1000).toLocaleDateString(locale);
  if (hasConn) $('pill-conn').textContent = t('pill.conn', { n: `${m.active ?? 0}/${m.max}` });
}

function tickClock() {
  const d = new Date();
  $('clock-time').textContent = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const day = d.toLocaleDateString(locale, { weekday: 'long' });
  $('clock-date').textContent = `${day}, ${d.getDate()} ${d.toLocaleDateString(locale, { month: 'short' })}`.toLocaleUpperCase(locale);
}

// Bottom action strip: navigation hints on the left, remote color-button cues in the middle.
function renderDock(screen) {
  const docks = new Map([
    [login, { ok: t('dock.select'), back: playlists.length ? t('dock.myLists') : t('dock.exit'), c: [] }],
    [listsScreen, { ok: t('dock.open'), back: source ? t('dock.home') : t('dock.exit'), c: [['y', t('dock.deleteList')], ['b', t('dock.refresh')]] }],
    [homeScreen, { ok: t('dock.start'), back: t('dock.exit'), c: [['b', t('dock.refresh')]] }],
    [browser, { ok: t('dock.watch'), back: t('key.back'), c: [['r', t('dock.search')], ['y', t('dock.favorite')]] }],
    [seriesScreen, { ok: t('dock.watch'), back: t('key.back'), c: [] }],
  ]);
  const d = docks.get(screen);
  if (!d) { $('dock').replaceChildren(); return; }
  const one = (...nodes) => { const e = document.createElement('span'); e.className = 'one'; e.append(...nodes); return e; };
  const left = document.createElement('div');
  left.className = 'grp';
  left.append(one(span('chip', '▲▼◄►'), t('dock.navigate')), one(span('chip ok', 'OK'), d.ok), one(span('chip', t('key.back')), d.back));
  const mid = document.createElement('div');
  mid.className = 'grp';
  mid.append(...d.c.map(([col, label]) => one(span(`cdot ${col}`, ''), label)));
  $('dock').replaceChildren(left, mid, span('ver', 'v1.0.0'));
}

function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

function osd(text) {
  const o = $('osd');
  o.textContent = text; o.hidden = false;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => (o.hidden = true), 3000);
}

const hhmm = (sec) => new Date(sec * 1000).toTimeString().slice(0, 5);

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}

function showOsd(ch) {
  osd(ch.name);
  nowNext(ch).then(({ now }) => {
    if (playing === ch && now) osd(`${ch.name}
${hhmm(now.start)}–${hhmm(now.stop)}  ${now.title}`);
  });
}

// ---- small DOM helpers ----
function button(text, extra = '') {
  const b = document.createElement('button');
  b.className = `item ${extra}`.trim();
  b.textContent = text;
  return b;
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function logoBox(ch) {
  const box = span('logo', (ch.name.match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase());
  if (ch.logo) {
    // Not lazy: an image that is not in the document yet is never fetched when loading="lazy".
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => box.replaceChildren(img);
    img.src = ch.logo;
  }
  return box;
}

function catButton(group, count) {
  const b = button('');
  b.append(span('lbl', groupLabel(group)), span('cnt', count));
  b.dataset.group = group;
  return b;
}

function chanRow(ch, sel, withFav = true) {
  const b = button('', sel ? 'sel' : '');
  b.append(logoBox(ch), span('cname', ch.name));
  if (withFav) {
    const on = favs.has(favId(ch));
    b.append(span(`favbtn${on ? ' on' : ''}`, on ? '★' : '☆'));
  }
  return b;
}

// Favorite button next to each row: Right moves onto it, OK toggles, Left/Back moves back (no color keys needed).
let favFocus = false;

function syncFavFocus() {
  document.querySelectorAll('.fav-focus').forEach((r) => r.classList.remove('fav-focus'));
  if (favFocus && view === 'chans') current()?.classList.add('fav-focus');
}

function setFavFocus(on) {
  favFocus = on;
  syncFavFocus();
}

// ---- info card (EPG for live, plot for movies/series) ----
function updateInfo(ch) {
  clearTimeout(infoTimer);
  const box = $('info');
  if (!ch) { box.hidden = true; return; }
  const kind = ch.kind || 'live';
  const stamp = `${kind}:${ch.id}`;
  box.hidden = false;
  box.dataset.id = stamp;
  const [label, cls] = BADGES[kind];
  const title = document.createElement('div');
  const h = document.createElement('h2');
  h.textContent = ch.name;
  title.append(span(cls, t(label)), h);
  const head = document.createElement('div');
  head.className = 'head';
  head.append(logoBox(ch), title);
  box.replaceChildren(head);
  infoTimer = setTimeout(async () => {
    if (kind === 'live') await fillEpg(box, ch, stamp);
    else await fillPlot(box, ch, kind, stamp);
  }, 250);
}

async function fillEpg(box, ch, stamp) {
  const { now, next } = await nowNext(ch);
  if (box.dataset.id !== stamp) return;
  const line = (label, p) => {
    const d = document.createElement('p');
    d.append(`${label}${p ? `  ${hhmm(p.start)}–${hhmm(p.stop)}` : ''}`);
    const b = document.createElement('b');
    b.textContent = p ? p.title : t('info.none');
    d.append(b);
    return d;
  };
  box.append(line(t('info.now'), now), line(t('info.next'), next));
  if (now) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, Math.max(0, ((Date.now() / 1000 - now.start) / (now.stop - now.start)) * 100))}%`;
    bar.append(fill);
    box.append(bar);
  }
}

async function fillPlot(box, ch, kind, stamp) {
  let info = { plot: ch.plot, genre: ch.genre, year: ch.year, rating: ch.rating, duration: ch.duration };
  if (kind === 'movie') {
    if (!vodInfo.has(ch.id)) vodInfo.set(ch.id, await xt.fetchVodInfo(source, ch.id).catch(() => ({})));
    info = { ...info, ...vodInfo.get(ch.id) };
  }
  if (box.dataset.id !== stamp) return;
  const rating = Number(info.rating) > 0 ? `★ ${Number(info.rating).toFixed(1)}` : '';
  const meta = [info.year, info.genre, info.duration, rating].filter(Boolean).join('  ·  ');
  if (meta) box.append(Object.assign(document.createElement('p'), { className: 'meta', textContent: meta }));
  const saved = positions[`${kind}:${ch.id}`];
  if (saved) box.append(Object.assign(document.createElement('p'), { className: 'meta', textContent: t('info.resumeAt', { time: fmtTime(saved.t) }) }));
  box.append(Object.assign(document.createElement('p'), { className: 'plot', textContent: info.plot || t('info.noPlot') }));
}

// ---- favorites ----
function toggleFav(ch) {
  if (!ch) return;
  const id = favId(ch);
  if (!favs.delete(id)) favs.add(id);
  saveFavs(source.id, favs);
  osd(`${favs.has(id) ? t('fav.added') : t('fav.removed')}: ${ch.name}`);
  groups.set(FAV, allChannels.filter((c) => favs.has(favId(c))));
  const catBtn = colCats.querySelector('[data-group="' + CSS.escape(FAV) + '"]');
  if (catBtn) catBtn.querySelector('.cnt').textContent = groups.get(FAV).length;
  const idx = Math.max(0, visible.indexOf(ch));
  const keepFavFocus = favFocus;
  renderChannels(curGroup);
  renderMore(idx + 40);
  if (view === 'chans') focus(list.children[Math.min(idx, list.children.length - 1)]);
  if (view === 'chans' && !list.children.length) {
    if (curGroup === SEARCH) enterSearch();
    else { view = 'cats'; focus(catBtn); }
  }
  favFocus = keepFavFocus && view === 'chans';
  syncFavFocus();
}

// ---- search: case- and accent-insensitive; every typed word must appear in the name ----
const fold = (s) => s.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function searchResults(query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const c of allChannels) {
    const name = fold(c.name);
    if (words.every((w) => name.includes(w))) {
      out.push(c);
      if (out.length >= MAX_RESULTS) break;
    }
  }
  return out;
}

function enterSearch() {
  view = 'search';
  setFavFocus(false);
  updateInfo(null);
  focus(search);
}

// ---- login ----
function setMode(mode) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('form-m3u').hidden = mode !== 'm3u';
  $('form-xtream').hidden = mode !== 'xtream';
}

function stopAll() {
  savePosition(true);
  pl.stop();
  playing = null;
  playCtx = null;
  hideBar();
  $('tracks').hidden = true;
  $('spin').hidden = true;
}

function showLogin(message = '') {
  stopAll();
  view = 'login';
  showScreen(login);
  $('login-msg').textContent = message;
  focus(items(login)[0]);
}

// ---- saved playlists ----
const hostOf = (p) => {
  try { return new URL(p.type === 'm3u' ? p.url : p.server).host; } catch { return ''; }
};

function fmtUpdated(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t('time.today', { hm });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return d.toDateString() === y.toDateString() ? t('time.yesterday', { hm }) : d.toLocaleDateString(locale);
}

function listRow(p) {
  const active = p.id === source?.id;
  const b = button('', `lrow${active ? ' sel' : ''}`);
  b.dataset.id = p.id;
  const title = document.createElement('div');
  title.className = 'ltitle';
  title.append(span('nm', p.name), span('tagb', p.type === 'xtream' ? 'XTREAM' : 'M3U'));
  if (active) title.append(span('tagb live', t('list.active')));
  const m = p.meta || {};
  const meta = document.createElement('div');
  meta.className = 'lmeta';
  meta.append(span('mono', hostOf(p)));
  const words = { live: t('unit.live'), movies: t('unit.movies'), series: t('unit.series') };
  const counts = Object.keys(words).filter((k) => m.counts?.[k] != null).map((k) => `${m.counts[k].toLocaleString(locale)} ${words[k]}`);
  if (counts.length) meta.append(span('', counts.join(' • ')));
  if (m.exp > 0) {
    const e = span('', `${t('list.expires')} `);
    e.append(span('hl', new Date(m.exp * 1000).toLocaleDateString(locale)));
    meta.append(e);
  }
  if (m.updated) meta.append(span('', t('list.updated', { when: fmtUpdated(m.updated) })));
  const main = document.createElement('div');
  main.className = 'lmain';
  main.append(title, meta);
  const btns = document.createElement('div');
  btns.className = 'lbtns';
  const mk = (act, label) => { const x = span(`lbtn ${act}`, label); x.dataset.act = act; x.dataset.label = label; return x; };
  btns.append(active ? mk('refresh', t('btn.refresh')) : mk('select', t('btn.select')), mk('del', t('btn.delete')));
  b.append(span(`licon ${p.type === 'xtream' ? 'x' : 'm'}`, ''), main, btns);
  return b;
}

function showLists(message = '') {
  if (!playlists.length) { showLogin(message); return; }
  stopAll();
  view = 'lists';
  rowBtn = -1;
  delArmed = false;
  showScreen(listsScreen);
  $('lists-msg').textContent = message;
  $('lists-total').textContent = t('lists.total', { n: playlists.length });
  const add = button('', 'lrow add');
  add.append(t('lists.add'), Object.assign(document.createElement('small'), { textContent: t('lists.addSub') }));
  add.dataset.add = '1';
  $('lists-items').replaceChildren(...playlists.map(listRow), add);
  const cur = $('lists-items').querySelector(`[data-id="${CSS.escape(source?.id ?? '')}"]`);
  focus(cur || $('lists-items').firstElementChild);
}

// Buttons inside a playlist row: Right/Left move between them, OK presses (Sil needs a second OK to confirm).
const rowButtons = (row) => [...row.querySelectorAll('.lbtn')];

function syncRowBtn() {
  const rows = $('lists-items');
  rows.querySelectorAll('.btn-focus').forEach((r) => r.classList.remove('btn-focus'));
  rows.querySelectorAll('.lbtn').forEach((b) => { b.classList.remove('focused', 'armed'); b.textContent = b.dataset.label; });
  if (rowBtn < 0) return;
  const row = current();
  row.classList.add('btn-focus');
  const b = rowButtons(row)[rowBtn];
  if (!b) return;
  b.classList.add('focused');
  if (b.dataset.act === 'del' && delArmed) { b.classList.add('armed'); b.textContent = t('btn.confirmDelete'); }
}

function setRowBtn(i, armed = false) {
  rowBtn = i;
  delArmed = armed;
  syncRowBtn();
}

function deletePlaylist(id) {
  playlists = playlists.filter((p) => p.id !== id);
  savePlaylists(playlists);
  deleteFavs(id);
  deletePos(id);
  deleteRecent(id);
  if (loadActive() === id) saveActive(null);
  if (source?.id === id) source = null;
  if (playlists.length) showLists(t('list.deleted')); else showLogin(t('list.deletedLast'));
}

const defaultName = (src) => {
  try { return new URL(src.type === 'm3u' ? src.url : src.server).hostname; } catch { return 'Listem'; }
};

// Many providers block get.php downloads but serve the same account through the Xtream API.
function xtreamFromM3U(url) {
  try {
    const u = new URL(url);
    const user = u.searchParams.get('username'), pass = u.searchParams.get('password');
    if (/\/get\.php$/i.test(u.pathname) && user && pass) return { type: 'xtream', server: u.origin, user, pass };
  } catch { /* not a valid URL */ }
  return null;
}

function normalizeSource(src) {
  const x = src.type === 'm3u' && xtreamFromM3U(src.url);
  if (!x) return src;
  const { url, ...rest } = src;
  const converted = { ...rest, ...x };
  playlists = playlists.map((p) => (p.id === src.id ? converted : p));
  if (playlists.some((p) => p.id === src.id)) savePlaylists(playlists);
  return converted;
}

async function loadSection(name, src) {
  if (name === 'live') {
    if (src.type === 'm3u') {
      const { channels, epgUrl } = await fetchM3U(src.url);
      configureEpg(src, epgUrl);
      return channels;
    }
    return xt.fetchLive(src);
  }
  return name === 'movies' ? xt.fetchMovies(src) : xt.fetchSeriesList(src);
}

async function fetchSection(name, src) {
  const items = await loadSection(name, src);
  return HIDE_ADULT ? items.filter((c) => !isAdult(c)) : items;
}

async function connect(src) {
  src = normalizeSource(src);
  const status = $(view === 'lists' || view === 'boot' ? 'lists-msg' : view === 'home' ? 'home-msg' : 'login-msg');
  status.textContent = t('loading');
  try {
    let live = null, info = null;
    if (src.type === 'm3u') live = await fetchSection('live', src);
    else info = await xt.login(src);

    src.meta = { ...src.meta, updated: Date.now() };
    if (info) {
      const u = info.user_info;
      src.meta = { ...src.meta, exp: Number(u.exp_date) || 0, max: u.max_connections, active: u.active_cons };
    } else {
      src.meta.counts = { ...src.meta.counts, live: live.length };
    }
    if (!playlists.some((p) => p.id === src.id)) playlists = [...playlists, src];
    savePlaylists(playlists);
    saveActive(src.id);
    source = src;
    cache = {};
    data = {};
    vodInfo.clear();
    seriesCache.clear();
    favs = loadFavs(src.id);
    positions = loadPos(src.id);
    recent = loadRecent(src.id);
    if (info) {
      configureEpg(src, null);
      homeIdx = 0;
      showHome();
      prefetch();
    } else {
      cache.live = Promise.resolve(live);
      data.live = live;
      homeIdx = 0;
      showHome();
    }
  } catch (e) {
    const msg = e.message || t('err.connection');
    if (playlists.some((p) => p.id === src.id)) showLists(msg); else showLogin(msg);
  }
}

// ---- home: live / movies / series / lists ----
const fmtCount = (n, word) => (n == null ? '—' : `${n.toLocaleString(locale)} ${word}`);

function renderCounts() {
  tiles.querySelectorAll('[data-section="movies"], [data-section="series"]').forEach((t) => { t.hidden = source?.type === 'm3u'; });
  $('cnt-live').textContent = fmtCount(data.live?.length, t('unit.live'));
  $('cnt-movies').textContent = fmtCount(data.movies?.length, t('unit.movies'));
  $('cnt-series').textContent = fmtCount(data.series?.length, t('unit.series'));
  $('tag-live').textContent = source?.type === 'xtream' ? t('tag.epg') : '';
  $('badge-lists').textContent = t('lists.count', { n: playlists.length });
  $('cnt-lists').textContent = source ? `● ${source.name} • ${source.type === 'xtream' ? 'Xtream' : 'M3U'}` : '';
}

function recentSub(r) {
  if (r.kind === 'live') return t('recent.live');
  const pos = positions[`${r.kind}:${r.id}`];
  const left = pos ? t('recent.left', { n: Math.max(1, Math.round((pos.d - pos.t) / 60)) }) : '';
  return `${r.kind === 'episode' ? r.name : t('recent.movie')}${left}`;
}

function renderRecent() {
  const cards = recent.slice(0, 4).map((r, i) => {
    const b = button('', 'rcard');
    b.dataset.r = i;
    const text = document.createElement('div');
    text.className = 'rtext';
    const name = document.createElement('b');
    name.textContent = r.kind === 'episode' ? (r.seriesName || r.name) : r.name;
    const sub = document.createElement('small');
    sub.textContent = recentSub(r);
    text.append(name, sub);
    b.append(logoBox(r), text);
    const pos = positions[`${r.kind}:${r.id}`];
    if (r.kind !== 'live' && pos) {
      const bar = span('rprog', '');
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, (pos.t / pos.d) * 100)}%`;
      bar.append(fill);
      b.append(bar);
    }
    return b;
  });
  $('home-recent').replaceChildren(...cards);
  $('recent-wrap').hidden = !cards.length;
}

function pushRecent(item, extra = {}) {
  const kind = item.kind || 'live';
  const entry = { kind, id: item.id, name: item.name, logo: item.logo || '', group: item.group || '', url: item.url, ...extra, at: Date.now() };
  recent = [entry, ...recent.filter((r) => !(r.kind === kind && r.id === item.id))].slice(0, 8);
  saveRecent(source.id, recent);
}

async function resumeRecent(r) {
  if (!r) return;
  if (r.kind !== 'live') { startVod(r, { back: 'home', episodes: [r], idx: 0, seriesName: r.seriesName }); return; }
  $('home-msg').textContent = t('loading');
  try {
    await sectionData('live');
  } catch (e) {
    $('home-msg').textContent = e.message || t('err.load');
    return;
  }
  enterSection('live');
  startLive(allChannels.find((c) => c.id === r.id) || r);
  enterFull();
}

function showHome() {
  stopAll();
  view = 'home';
  showScreen(homeScreen);
  $('home-msg').textContent = '';
  renderCounts();
  renderRecent();
  focus(tiles.children[homeIdx]);
}

// Section lists are fetched once per connection (in the background after login) and counted for the tiles.
function noteCount(name, n) {
  source.meta = { ...source.meta, counts: { ...source.meta?.counts, [name]: n } };
  savePlaylists(playlists);
}

function sectionData(name) {
  const src = source;
  if (!cache[name]) {
    cache[name] = fetchSection(name, src).then((items) => {
      if (source === src) {
        data[name] = items;
        noteCount(name, items.length);
        if (view === 'home') renderCounts();
      }
      return items;
    }).catch((e) => { delete cache[name]; throw e; });
  }
  return cache[name];
}

async function prefetch() {
  const src = source;
  for (const name of ['live', 'movies', 'series']) {
    if (source !== src) return;
    try { await sectionData(name); } catch { /* the error is shown when the section is opened */ }
  }
}

async function openSection(name) {
  if (name === 'lists') { showLists(); return; }
  if (loading) return;
  homeIdx = [...tiles.children].findIndex((t) => t.dataset.section === name);
  if (!data[name]) {
    loading = true;
    $('home-msg').textContent = t('loading');
    try {
      await sectionData(name);
    } catch (e) {
      $('home-msg').textContent = e.message || t('err.load');
      return;
    } finally {
      loading = false;
    }
  }
  enterSection(name);
}

function enterSection(name) {
  section = name;
  allChannels = data[name];
  showBrowser();
}

// ---- browser ----
function showBrowser() {
  groups = new Map([[ALL, allChannels], [FAV, allChannels.filter((c) => favs.has(favId(c)))]]);
  curGroup = ALL;
  for (const c of allChannels) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  groupNames = [...groups.keys()];
  const searchBtn = button(t('search.btn'));
  searchBtn.dataset.group = SEARCH;
  colCats.replaceChildren(searchBtn, ...groupNames.map((g) => catButton(g, groups.get(g).length)));
  search.value = '';
  view = 'cats';
  showScreen(browser);
  focus(colCats.children[1]);
  renderChannels(ALL);
}

function renderChannels(group) {
  curGroup = group;
  const isSearch = group === SEARCH;
  search.hidden = !isSearch;
  visible = isSearch ? searchResults(search.value) : groups.get(group) || [];
  $('search-empty').hidden = !(isSearch && search.value.trim() && !visible.length);
  list.replaceChildren();
  rendered = 0;
  renderMore(CHUNK);
  colChans.scrollTop = 0;
}

// Large catalogs are rendered a chunk at a time as the user scrolls down.
function renderMore(upTo) {
  upTo = Math.min(visible.length, upTo);
  if (upTo <= rendered) return;
  const rows = [];
  for (let i = rendered; i < upTo; i++) {
    const b = chanRow(visible[i], visible[i] === playing);
    b.dataset.i = i;
    rows.push(b);
  }
  list.append(...rows);
  rendered = upTo;
}

const groupBtn = () => colCats.querySelector('[data-group="' + CSS.escape(curGroup) + '"]');

function backToCats() {
  view = 'cats';
  setFavFocus(false);
  updateInfo(null);
  focus(groupBtn());
}

function focusRow(item) {
  const i = visible.indexOf(item);
  renderMore(i + 40);
  const row = list.children[Math.max(0, i)];
  if (!row) { backToCats(); return; }
  view = 'chans';
  focus(row);
  updateInfo(visible[+row.dataset.i]);
}

function openItem(item) {
  if (!item) return;
  const kind = item.kind || 'live';
  if (kind === 'live') { startLive(item); enterFull(); }
  else if (kind === 'movie') startVod(item, { back: 'chans', episodes: [item], idx: 0 });
  else openSeries(item);
}

// ---- series ----
async function openSeries(item) {
  osd(t('loading'));
  try {
    if (!seriesCache.has(item.id)) seriesCache.set(item.id, await xt.fetchSeriesInfo(source, item.id));
  } catch (e) {
    toast(e.message);
    return;
  }
  $('osd').hidden = true;
  const seasons = seriesCache.get(item.id);
  if (!seasons.length) { toast(t('toast.noEpisodes')); return; }
  seasons.forEach((s, si) => s.episodes.forEach((e, ei) => { e.si = si; e.ei = ei; }));
  curSeries = { item, seasons, flat: seasons.flatMap((s) => s.episodes) };
  colSeasons.replaceChildren(...seasons.map((s, si) => {
    const b = catButton(s.name, s.episodes.length);
    b.dataset.s = si;
    return b;
  }));
  view = 'series';
  showScreen(seriesScreen);
  focus(colSeasons.firstElementChild);
  renderEpisodes(0);
  updateInfo(item);
}

function renderEpisodes(si) {
  curSeason = si;
  colEps.replaceChildren(...curSeries.seasons[si].episodes.map((e, i) => {
    const b = chanRow(e, false, false);
    b.dataset.e = i;
    return b;
  }));
  colEps.scrollTop = 0;
}

const episodeOf = (row) => curSeries.seasons[curSeason].episodes[+row.dataset.e];

function leaveSeries() {
  view = 'chans';
  showScreen(browser);
  focusRow(curSeries.item);
}

// ---- playback ----
function startLive(ch) {
  playing = ch;
  playCtx = { kind: 'live' };
  pushRecent(ch);
  showOsd(ch);
  pl.play(ch.url, { onError: (why) => toast(t('toast.playFail', { why })) });
  list.querySelectorAll('.item').forEach((b) => b.classList.toggle('sel', visible[b.dataset.i] === ch));
}

function startVod(item, ctx) {
  savePosition(true);
  playing = item;
  playCtx = { kind: 'vod', ...ctx };
  pushRecent(item, ctx.seriesName ? { seriesName: ctx.seriesName } : {});
  const at = positions[posKey(item)]?.t || 0;
  $('vtitle').textContent = ctx.seriesName ? `${ctx.seriesName} · ${item.name}` : item.name;
  $('vsub').textContent = at ? t('resume.from', { time: fmtTime(at) }) : '';
  pl.play(item.url, { startAt: at, onError: (why) => toast(t('toast.playFail', { why })) });
  $('vctl').querySelector('[data-act="prev"]').hidden = ctx.idx <= 0;
  $('vctl').querySelector('[data-act="next"]').hidden = ctx.idx >= ctx.episodes.length - 1;
  enterFull();
  showBar();
}

function enterFull() {
  view = 'full';
  showScreen(null);
}

function leaveFull() {
  if (playCtx?.kind === 'vod') {
    const { back } = playCtx;
    const item = playing;
    stopAll();
    if (back === 'home') { showHome(); return; }
    if (back === 'series') {
      view = 'series';
      showScreen(seriesScreen);
      renderEpisodes(item.si);
      focus(colEps.children[item.ei]);
      updateInfo(item);
    } else {
      view = 'chans';
      showScreen(browser);
      focusRow(item);
    }
    return;
  }
  view = 'chans';
  showScreen(browser);
  focusRow(playing);
}

function zap(delta) {
  if (!visible.length) return;
  const i = visible.indexOf(playing);
  startLive(visible[(i + delta + visible.length) % visible.length]);
}

function stepEpisode(delta) {
  const { episodes, idx } = playCtx;
  const next = episodes[idx + delta];
  if (next) startVod(next, { ...playCtx, idx: idx + delta });
}

function savePosition(force) {
  if (playCtx?.kind !== 'vod' || !playing || !source) return;
  const d = video.duration, t = video.currentTime;
  if (!isFinite(d) || d <= 0) return;
  if (!force && Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  const k = posKey(playing);
  const tail = Math.min(60, d * 0.05);          // the last minute (or 5% of a short clip) counts as finished
  if (t > 30 && t < d - tail) positions[k] = { t, d, at: Date.now() };
  else if (t >= d - tail) delete positions[k];  // finished; early seconds keep the old resume point
  else return;
  savePos(source.id, positions);
}

function onEnded() {
  if (playCtx?.kind !== 'vod') return;
  delete positions[posKey(playing)];
  savePos(source.id, positions);
  if (playCtx.episodes[playCtx.idx + 1]) stepEpisode(1); else leaveFull();
}

function updateBar() {
  const d = video.duration, cur = video.currentTime;
  $('vcur').textContent = fmtTime(cur);
  $('vdur').textContent = isFinite(d) ? fmtTime(d) : '--:--';
  const pct = isFinite(d) && d > 0 ? `${(cur / d) * 100}%` : '0%';
  $('vfill').style.width = pct;
  $('vpin').style.left = pct;
  $('vstate').textContent = video.paused ? t('player.paused') : t('player.playing');
  $('vtoggle').textContent = video.paused ? t('player.play') : t('player.pause');
}

function showBar() {
  updateBar();
  $('vbar').hidden = false;
  clearTimeout(barTimer);
  if (!video.paused && view !== 'vctl') barTimer = setTimeout(hideBar, 4500);
}

function hideBar() {
  clearTimeout(barTimer);
  $('vbar').hidden = true;
}

// Repeated presses within 0.7 s step further: 10, 10, 20, 30, 60, 120 s.
function seekBy(dir, fixed) {
  const now = Date.now();
  seekStreak = now - lastSeek < 700 ? seekStreak + 1 : 0;
  lastSeek = now;
  const step = fixed ?? [10, 10, 20, 30, 60, 120][Math.min(seekStreak, 5)];
  const d = isFinite(video.duration) ? video.duration - 1 : Infinity;
  video.currentTime = Math.max(0, Math.min(d, video.currentTime + dir * step));
  showBar();
}

function togglePause() {
  if (video.paused) video.play().catch(() => {}); else video.pause();
  showBar();
}

// ---- audio / subtitle menu ----
function fillTracks(box, kind, tracks) {
  if (!tracks.length) {
    box.replaceChildren(span('empty', t('tracks.none')));
    return;
  }
  box.replaceChildren(...tracks.map((t) => {
    const b = button(t.label, t.active ? 'sel' : '');
    b.dataset.kind = kind;
    b.dataset.id = t.id;
    return b;
  }));
}

function openTracks() {
  const audio = pl.audioTracks();
  const subs = pl.textTracks();
  fillTracks($('tracks-audio'), 'audio', audio);
  fillTracks($('tracks-sub'), 'sub', subs.length ? [{ id: -1, label: t('tracks.off'), active: !subs.some((t) => t.active) }, ...subs] : []);
  $('tracks').hidden = false;
  view = 'tracks';
  const first = $('tracks').querySelector('.item.sel') || $('tracks').querySelector('.item');
  focus(first);
}

function closeTracks() {
  $('tracks').hidden = true;
  view = 'full';
  if (playCtx?.kind === 'vod') showBar();
}

const otherColumn = () => $(current().dataset.kind === 'audio' ? 'tracks-sub' : 'tracks-audio');

// ---- keys ----
document.addEventListener('keydown', (e) => {
  const k = e.keyCode;
  const inInput = e.target.tagName === 'INPUT';
  const dir = k === KEY.UP ? -1 : 1;

  if (view === 'lists') {
    const el = current();
    const isList = !!el.dataset.id;
    const btns = isList ? rowButtons(el) : [];
    const delIdx = btns.findIndex((b) => b.dataset.act === 'del');
    if (k === KEY.UP || k === KEY.DOWN) { move($('lists-items'), dir); setRowBtn(-1); }
    else if (k === KEY.RIGHT && isList) setRowBtn(Math.min(btns.length - 1, rowBtn + 1));
    else if (k === KEY.LEFT && rowBtn >= 0) setRowBtn(rowBtn - 1);
    else if ((k === KEY.BACK || k === KEY.ESC) && rowBtn >= 0) setRowBtn(-1);
    else if (k === KEY.OK) {
      if (rowBtn >= 0 && btns[rowBtn].dataset.act === 'del') { if (delArmed) deletePlaylist(el.dataset.id); else setRowBtn(rowBtn, true); }
      else if (el.dataset.add) showLogin();
      else connect(playlists.find((p) => p.id === el.dataset.id));
    }
    else if ((k === KEY.YELLOW || k === KEY.D) && isList) setRowBtn(delIdx, true);
    else if (k === KEY.BLUE && isList) connect(playlists.find((p) => p.id === el.dataset.id));
    else if ((k === KEY.BACK || k === KEY.ESC) && source) showHome();
    else if (k === KEY.BACK || k === KEY.ESC) exitApp();
    else return;
    e.preventDefault(); return;
  }

  if (view === 'home') {
    const inRecent = !!current()?.closest('#home-recent');
    if (k === KEY.LEFT || k === KEY.RIGHT) {
      move(current().parentElement, k === KEY.LEFT ? -1 : 1);
      if (!inRecent) homeIdx = [...tiles.children].indexOf(current());
    }
    else if (k === KEY.DOWN && !inRecent && $('home-recent').firstElementChild) focus($('home-recent').firstElementChild);
    else if (k === KEY.UP && inRecent) focus(tiles.children[homeIdx]);
    else if (k === KEY.OK) {
      if (inRecent) resumeRecent(recent[+current().dataset.r]); else openSection(current().dataset.section);
    }
    else if (k === KEY.BLUE) connect(source);
    else if (k === KEY.BACK || k === KEY.ESC) exitApp();
    else return;
    e.preventDefault(); return;
  }

  if (view === 'login') {
    if (k === KEY.BACK || k === KEY.ESC) { if (playlists.length) showLists(); else exitApp(); e.preventDefault(); return; }
    if (k === KEY.UP) { move(login, -1); e.preventDefault(); }
    else if (k === KEY.DOWN) { move(login, 1); e.preventDefault(); }
    else if (!inInput && (k === KEY.LEFT || k === KEY.RIGHT) && current()?.classList.contains('tab')) {
      move($('login').querySelector('.tabs'), k === KEY.LEFT ? -1 : 1); e.preventDefault();
    }
    else if (k === KEY.OK && current()?.classList.contains('tab')) {
      setMode(current().dataset.mode); e.preventDefault();
    }
    return;
  }

  if (view === 'cats') {
    if (k === KEY.UP || k === KEY.DOWN) {
      move(colCats, dir);
      renderChannels(current().dataset.group);
    } else if (k === KEY.RIGHT || k === KEY.OK) {
      if (curGroup === SEARCH) enterSearch();
      else if (list.firstElementChild) { view = 'chans'; focus(list.firstElementChild); updateInfo(visible[0]); }
    } else if (k === KEY.RED || k === KEY.S) {
      focus(colCats.firstElementChild); renderChannels(SEARCH); enterSearch();
    } else if (k === KEY.BACK || k === KEY.ESC) {
      showHome();
    } else return;
    e.preventDefault(); return;
  }

  if (view === 'search') {
    // Text keys (incl. left/right/backspace) go to the input untouched.
    if (k === KEY.DOWN || k === KEY.OK) {
      if (list.firstElementChild) { view = 'chans'; search.blur(); focus(list.firstElementChild); updateInfo(visible[0]); }
    } else if (k === KEY.UP || k === KEY.BACK || k === KEY.ESC) {
      view = 'cats'; focus(colCats.firstElementChild);
    } else return;
    e.preventDefault(); return;
  }

  if (view === 'chans') {
    if (k === KEY.UP && curGroup === SEARCH && current() === list.firstElementChild) { enterSearch(); e.preventDefault(); return; }
    if (k === KEY.RED || k === KEY.S) { focus(colCats.firstElementChild); renderChannels(SEARCH); enterSearch(); e.preventDefault(); return; }
    if (k === KEY.UP || k === KEY.DOWN || k === KEY.PGUP || k === KEY.PGDN) {
      move(list, k === KEY.UP ? -1 : k === KEY.DOWN ? 1 : k === KEY.PGUP ? -8 : 8);
      const i = +current().dataset.i;
      renderMore(i + 40);
      updateInfo(visible[i]);
      syncFavFocus();
    }
    else if (k === KEY.YELLOW || k === KEY.F) toggleFav(visible[+current().dataset.i]);
    else if (k === KEY.RIGHT) setFavFocus(true);
    else if (k === KEY.LEFT || k === KEY.BACK || k === KEY.ESC) { if (favFocus) setFavFocus(false); else backToCats(); }
    else if (k === KEY.OK) { const it = visible[+current().dataset.i]; if (favFocus) toggleFav(it); else openItem(it); }
    else return;
    e.preventDefault(); return;
  }

  if (view === 'series') {
    const inEps = current()?.closest('#col-eps');
    if (k === KEY.UP || k === KEY.DOWN) {
      if (inEps) { move(colEps, dir); updateInfo(episodeOf(current())); }
      else { move(colSeasons, dir); renderEpisodes(+current().dataset.s); }
    }
    else if (k === KEY.RIGHT || (k === KEY.OK && !inEps)) {
      if (colEps.firstElementChild) { focus(colEps.firstElementChild); updateInfo(episodeOf(colEps.firstElementChild)); }
    }
    else if (k === KEY.LEFT && inEps) { focus(colSeasons.children[curSeason]); updateInfo(curSeries.item); }
    else if (k === KEY.OK && inEps) playEpisode(episodeOf(current()));
    else if (k === KEY.BACK || k === KEY.ESC) leaveSeries();
    else return;
    e.preventDefault(); return;
  }

  if (view === 'tracks') {
    if (k === KEY.UP || k === KEY.DOWN) move(current().parentElement, dir);
    else if (k === KEY.LEFT || k === KEY.RIGHT) {
      const box = otherColumn();
      focus(box.querySelector('.item.sel') || box.querySelector('.item'));
    }
    else if (k === KEY.OK) applyTrack(current());
    else if (k === KEY.BACK || k === KEY.ESC || k === KEY.GREEN || k === KEY.RED || k === KEY.T) closeTracks();
    else return;
    e.preventDefault(); return;
  }

  if (view === 'vctl') {
    if (k === KEY.LEFT || k === KEY.RIGHT) move($('vctl'), k === KEY.LEFT ? -1 : 1);
    else if (k === KEY.OK) vctlAct(current().dataset.act);
    else if (k === KEY.UP || k === KEY.BACK || k === KEY.ESC) leaveControls();
    else if (k === KEY.PLAY || k === KEY.PAUSE) togglePause();
    else if (k === KEY.RW) seekBy(-1);
    else if (k === KEY.FF) seekBy(1);
    else if (k === KEY.GREEN || k === KEY.RED || k === KEY.T) openTracks();
    else if (k === KEY.CH_UP || k === KEY.PGDN) stepEpisode(1);
    else if (k === KEY.CH_DOWN || k === KEY.PGUP) stepEpisode(-1);
    else return;
    e.preventDefault(); return;
  }

  if (view === 'full') {
    const vod = playCtx?.kind === 'vod';
    if (k === KEY.GREEN || k === KEY.RED || k === KEY.T || (vod && k === KEY.UP)) openTracks();
    else if (k === KEY.BACK || k === KEY.ESC || k === KEY.STOP) leaveFull();
    else if (vod) {
      if (k === KEY.LEFT || k === KEY.RW) seekBy(-1);
      else if (k === KEY.RIGHT || k === KEY.FF) seekBy(1);
      else if (k === KEY.OK || k === KEY.PLAY || k === KEY.PAUSE) togglePause();
      else if (k === KEY.DOWN) enterControls();
      else if (k === KEY.INFO) showBar();
      else if (k === KEY.CH_UP || k === KEY.PGDN) stepEpisode(1);
      else if (k === KEY.CH_DOWN || k === KEY.PGUP) stepEpisode(-1);
      else return;
    }
    else if (k === KEY.RIGHT) openTracks();
    else if (k === KEY.OK) leaveFull();
    else if (k === KEY.UP) zap(-1);
    else if (k === KEY.DOWN || k === KEY.CH_UP) zap(1);
    else if (k === KEY.CH_DOWN) zap(-1);
    else if (k === KEY.INFO) showOsd(playing);
    else if (k === KEY.YELLOW || k === KEY.F) toggleFav(playing);
    else return;
    e.preventDefault();
  }
});

// ---- wiring ----
search.addEventListener('input', () => renderChannels(SEARCH));
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
login.addEventListener('focusin', (e) => e.target.classList.contains('item') && focus(e.target));

video.addEventListener('waiting', () => { $('spin').hidden = false; });
['playing', 'pause', 'ended', 'emptied', 'error'].forEach((ev) => video.addEventListener(ev, () => { $('spin').hidden = true; }));
video.addEventListener('timeupdate', () => {
  if (playCtx?.kind !== 'vod') return;
  if (!$('vbar').hidden) updateBar();
  savePosition(false);
});
video.addEventListener('ended', onEnded);

// Picture but no sound usually means the device cannot decode the stream's audio format (AC-3, E-AC-3, DTS...).
// Where the browser reports decoded audio bytes, say so instead of leaving the viewer guessing.
let audioCheck, audioWarnedFor = '';
video.addEventListener('playing', () => {
  clearTimeout(audioCheck);
  audioCheck = setTimeout(() => {
    const bytes = video.webkitAudioDecodedByteCount;
    if (typeof bytes === 'number' && bytes === 0 && !video.paused && !video.muted && video.currentTime > 2 && audioWarnedFor !== video.currentSrc) {
      audioWarnedFor = video.currentSrc;
      toast(t('toast.audio'));
    }
  }, 4000);
});
video.addEventListener('emptied', () => clearTimeout(audioCheck));
['pause', 'play'].forEach((ev) => video.addEventListener(ev, () => {
  if (view === 'full' && playCtx?.kind === 'vod') showBar();
}));
window.addEventListener('pagehide', () => savePosition(true));

$('form-m3u').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('m3u-url').value.trim();
  if (url) connect(newSource({ type: 'm3u', url }));
});
$('form-xtream').addEventListener('submit', (e) => {
  e.preventDefault();
  const server = $('xt-server').value.trim(), user = $('xt-user').value.trim(), pass = $('xt-pass').value;
  if (server && user) connect(newSource({ type: 'xtream', server: xt.normalizeServer(server), user, pass }));
});

function newSource(fields) {
  const name = $('pl-name').value.trim() || defaultName(fields);
  return { id: Date.now().toString(36), name, ...fields };
}

// ---- shared actions (keys and pointer) ----
function playEpisode(ep) {
  startVod(ep, { back: 'series', episodes: curSeries.flat, idx: curSeries.flat.indexOf(ep), seriesName: curSeries.item.name });
}

function applyTrack(el) {
  if (el.dataset.kind === 'audio') pl.setAudio(+el.dataset.id); else pl.setText(+el.dataset.id);
  el.parentElement.querySelectorAll('.item').forEach((b) => b.classList.toggle('sel', b === el));
}

// On-screen playback buttons (for remotes without media keys): Down from the player moves onto them.
function enterControls() {
  showBar();
  view = 'vctl';
  focus($('vctl').querySelector('[data-act="toggle"]'));
}

function leaveControls() {
  $('vctl').querySelectorAll('.focus').forEach((b) => b.classList.remove('focus'));
  view = 'full';
  showBar();
}

function vctlAct(act) {
  if (act === 'toggle') togglePause();
  else if (act === 'back') seekBy(-1, 10);
  else if (act === 'fwd') seekBy(1, 10);
  else if (act === 'prev') stepEpisode(-1);
  else if (act === 'next') stepEpisode(1);
  else if (act === 'tracks') openTracks();
}

function listButton(row, btn) {
  const idx = rowButtons(row).indexOf(btn);
  if (btn.dataset.act === 'del') {
    if (delArmed && rowBtn === idx) deletePlaylist(row.dataset.id); else setRowBtn(idx, true);
  } else {
    connect(playlists.find((p) => p.id === row.dataset.id));
  }
}

// ---- Magic Remote (pointer) support: hover focuses, click presses, the wheel scrolls ----
const BROWSE = ['cats', 'chans', 'search'];

function containerView(el) {
  if (el.closest('#col-cats')) return 'cats';
  if (el.closest('#chan-list')) return 'chans';
  if (el.closest('#col-seasons, #col-eps')) return 'series';
  if (el.closest('#home-tiles, #home-recent')) return 'home';
  if (el.closest('#lists-items')) return 'lists';
  if (el.closest('#vctl')) return 'vctl';
  if (el.closest('#tracks')) return 'tracks';
  return null;
}

document.addEventListener('mousemove', (e) => {
  if (view === 'full' && playCtx?.kind === 'vod') showBar();
  const el = e.target.closest ? e.target.closest('.item') : null;
  if (!el || el.tagName === 'INPUT') return;
  const v = containerView(el);
  if (!v) return;
  const allowed = v === view || (BROWSE.includes(v) && BROWSE.includes(view)) || (v === 'vctl' && view === 'full');
  if (!allowed) return;
  const changed = el !== current();
  view = v;
  if (changed) focus(el);
  if (v === 'chans') {
    if (changed) { const i = +el.dataset.i; renderMore(i + 40); updateInfo(visible[i]); }
    setFavFocus(!!e.target.closest('.favbtn'));
  } else if (v === 'cats' && changed) {
    renderChannels(el.dataset.group);
  } else if (v === 'series' && changed) {
    if (el.closest('#col-seasons')) { renderEpisodes(+el.dataset.s); updateInfo(curSeries.item); } else updateInfo(episodeOf(el));
  } else if (v === 'home' && changed && el.closest('#home-tiles')) {
    homeIdx = [...tiles.children].indexOf(el);
  } else if (v === 'lists') {
    const idx = rowButtons(el).indexOf(e.target.closest('.lbtn'));
    if (changed || idx !== rowBtn) setRowBtn(idx);
  }
});

document.addEventListener('click', (e) => {
  if (e.detail === 0) return;          // clicks produced by the OK key are handled by the keydown logic
  const t = e.target;
  if (view === 'full') { if (playCtx?.kind === 'vod') showBar(); else leaveFull(); return; }
  if (t === search) { if (view !== 'search') enterSearch(); return; }
  const el = t.closest ? t.closest('.item') : null;
  if (!el || el.tagName === 'INPUT') return;
  const v = containerView(el);
  if (!v) return;
  view = v;
  focus(el);
  if (v === 'home') {
    if (el.closest('#home-recent')) resumeRecent(recent[+el.dataset.r]);
    else { homeIdx = [...tiles.children].indexOf(el); openSection(el.dataset.section); }
  } else if (v === 'cats') {
    renderChannels(el.dataset.group);
    if (curGroup === SEARCH) enterSearch();
  } else if (v === 'chans') {
    const it = visible[+el.dataset.i];
    if (t.closest('.favbtn')) toggleFav(it); else openItem(it);
  } else if (v === 'series') {
    if (el.closest('#col-seasons')) { renderEpisodes(+el.dataset.s); updateInfo(curSeries.item); } else playEpisode(episodeOf(el));
  } else if (v === 'lists') {
    const btn = t.closest('.lbtn');
    if (btn) listButton(el, btn);
    else if (el.dataset.add) showLogin();
    else connect(playlists.find((p) => p.id === el.dataset.id));
  } else if (v === 'vctl') {
    vctlAct(el.dataset.act);
  } else if (v === 'tracks') {
    applyTrack(el);
  }
});

document.addEventListener('wheel', (e) => {
  const box = e.target.closest ? e.target.closest('.col, .scroller') : null;
  if (!box) return;
  box.scrollTop += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (box === colChans && box.scrollTop + box.clientHeight > box.scrollHeight - 600) renderMore(rendered + CHUNK);
  e.preventDefault();
}, { passive: false });

$('vbar').querySelector('.vtrack').addEventListener('click', (e) => {
  if (!isFinite(video.duration)) return;
  const r = e.currentTarget.getBoundingClientRect();
  video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
  showBar();
});

applyStatic();

const startList = playlists.find((p) => p.id === loadActive());
if (startList) { view = 'boot'; showLists(); connect(startList); }
else if (playlists.length) showLists();
else showLogin();

tickClock();
setInterval(tickClock, 20000);
setTimeout(() => $('splash').classList.add('gone'), 1500);
