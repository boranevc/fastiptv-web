import { t, lang } from './i18n.js';

const video = document.getElementById('video');
let hls = null;
let pendingSeek = null;

export const el = video;

// webOS decodes HLS with the TV's own pipeline (AC-3, E-AC-3, MP2 audio included). hls.js goes through MSE,
// which often drops those audio codecs and leaves the picture without sound, so webOS plays HLS natively.
const preferNative = () => /web0s|webos/i.test(navigator.userAgent) && !!video.canPlayType('application/vnd.apple.mpegurl');

function startHls(url, onError) {
  hls = new Hls({ lowLatencyMode: true });
  hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) onError?.(d.details); });
  hls.loadSource(url);
  hls.attachMedia(video);
}

export function play(url, { onError, startAt = 0 } = {}) {
  stop();
  if (startAt) {
    pendingSeek = () => { video.currentTime = startAt; };
    video.addEventListener('loadedmetadata', pendingSeek, { once: true });
  }
  const hlsOk = window.Hls && Hls.isSupported() && /\.m3u8(\?|$)/i.test(url);
  if (hlsOk && !preferNative()) {
    startHls(url, onError);
  } else {
    video.src = url;
    video.onerror = () => {
      video.onerror = null;
      if (hlsOk) { video.removeAttribute('src'); startHls(url, onError); }   // native playback failed: try hls.js
      else onError?.(t('err.stream'));
    };
  }
  video.play().catch(() => {});
}

export function stop() {
  if (pendingSeek) { video.removeEventListener('loadedmetadata', pendingSeek); pendingSeek = null; }
  if (hls) { hls.destroy(); hls = null; }
  video.onerror = null;
  video.removeAttribute('src');
  video.load();
}

// ---- audio / subtitle tracks (what is offered depends on the stream and the TV) ----
const langName = (code) => {
  try { return new Intl.DisplayNames([lang], { type: 'language' }).of(code); } catch { return code; }
};

const label = (name, lang, i) => name || (lang && langName(lang)) || t('track.n', { n: i + 1 });
const isSub = (t) => t.kind === 'subtitles' || t.kind === 'captions';
const hlsHas = (list) => hls && list && list.length > 0;

export function audioTracks() {
  if (hlsHas(hls?.audioTracks)) {
    return hls.audioTracks.map((t, i) => ({ id: i, label: label(t.name, t.lang, i), active: i === hls.audioTrack }));
  }
  const list = video.audioTracks;
  if (!list) return [];
  return [...list].map((t, i) => ({ id: i, label: label(t.label, t.language, i), active: t.enabled }));
}

export function setAudio(id) {
  if (hlsHas(hls?.audioTracks)) { hls.audioTrack = id; return; }
  const list = video.audioTracks;
  if (list) [...list].forEach((t, i) => { t.enabled = i === id; });
}

export function textTracks() {
  if (hlsHas(hls?.subtitleTracks)) {
    return hls.subtitleTracks.map((t, i) => ({ id: i, label: label(t.name, t.lang, i), active: i === hls.subtitleTrack }));
  }
  return [...video.textTracks].filter(isSub)
    .map((t, i) => ({ id: i, label: label(t.label, t.language, i), active: t.mode === 'showing' }));
}

export function setText(id) {
  if (hlsHas(hls?.subtitleTracks)) {
    hls.subtitleTrack = id;
    hls.subtitleDisplay = id >= 0;
    return;
  }
  [...video.textTracks].filter(isSub).forEach((t, i) => { t.mode = i === id ? 'showing' : 'disabled'; });
}
