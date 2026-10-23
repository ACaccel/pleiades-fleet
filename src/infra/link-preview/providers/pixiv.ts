/** Pixiv artwork links normalized for operator-configured embed proxies. */
import { createRewriteProvider } from './rewrite-provider';
import type { OgClient } from '../og-client';
import type { LinkPreviewProvider } from '../types';

const PIXIV_HOSTS: ReadonlySet<string> = new Set(['pixiv.net', 'www.pixiv.net', 'm.pixiv.net']);
const ARTWORK_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?artworks\/([1-9]\d*)\/?$/i;
const SHORT_PATH = /^\/i\/([1-9]\d*)\/?$/;

const artworkId = (url: URL): string | undefined => {
  if (!['http:', 'https:'].includes(url.protocol) || !PIXIV_HOSTS.has(url.hostname)) {
    return undefined;
  }
  const match = ARTWORK_PATH.exec(url.pathname) ?? SHORT_PATH.exec(url.pathname);
  if (match !== null) return match[1];
  if (url.pathname !== '/member_illust.php') return undefined;
  const id = url.searchParams.get('illust_id');
  return id !== null && /^[1-9]\d*$/.test(id) ? id : undefined;
};

export const createPixivProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
}): LinkPreviewProvider =>
  createRewriteProvider({
    name: 'pixiv',
    matches: (url) => artworkId(url) !== undefined,
    sourceDomains: ['pixiv.net'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    // Canonical paths keep legacy IDs while dropping share attribution.
    toProxyUrl: (url, host) => `https://${host}/artworks/${artworkId(url)}`,
  });
