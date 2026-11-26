import { ProxyAgent } from 'undici';
import { UA } from './comps.js';

export function createFetch(config) {
  const dispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : undefined;
  return (url, opts = {}) => fetch(url, {
    ...opts,
    dispatcher,
    signal: opts.signal || AbortSignal.timeout(30000),
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
  });
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
