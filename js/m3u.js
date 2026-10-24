import { explainFetchFailure } from './net.js';
import { t } from './i18n.js';

// Channel shape shared by all sources: { id, name, logo, group, url }

const ATTR = /([\w-]+)="([^"]*)"/g;

// The title follows the first comma outside quotes: attribute values may hold commas, and so may the title itself.
function titleComma(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ',' && !quoted) return i;
  }
  return -1;
}

export function parseM3U(text) {
  const channels = [];
  const header = text.match(/^#EXTM3U.*/m);
  channels.epgUrl = header ? (header[0].match(/(?:url-tvg|x-tvg-url)="([^"]*)"/i) || [])[1] || '' : '';
  let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
      const comma = titleComma(line);
      meta = { attrs, name: comma >= 0 ? line.slice(comma + 1).trim() : '' };
    } else if (!line.startsWith('#') && meta) {
      channels.push({
        id: meta.attrs['tvg-id'] || line,
        name: meta.name || meta.attrs['tvg-name'] || line,
        logo: meta.attrs['tvg-logo'] || '',
        group: meta.attrs['group-title'] || t('group.other'),
        url: line,
      });
      meta = null;
    }
  }
  return channels;
}

export async function fetchM3U(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(await explainFetchFailure(url));
  }
  if (!res.ok) throw new Error(t('err.list', { code: res.status }));
  const channels = parseM3U(await res.text());
  if (!channels.length) throw new Error(t('err.noItems'));
  return { channels, epgUrl: channels.epgUrl.split(',')[0] };
}
