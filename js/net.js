import { t } from './i18n.js';

// When a request fails the browser only says "Failed to fetch". These probes tell the cause apart so the TV can
// show something the viewer can act on.

async function reachable(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function explainFetchFailure(url) {
  // The browser blocks http requests from an https page before they leave the device (web version only).
  if (location.protocol === 'https:' && /^http:/i.test(url)) return t('net.mixed');
  // A no-cors request succeeds whenever the server answers, even if the app is not allowed to read the reply.
  if (await reachable(url)) return t('net.cors');
  if (await reachable('https://www.gstatic.com/generate_204')) return t('net.dns');
  return t('net.offline');
}
