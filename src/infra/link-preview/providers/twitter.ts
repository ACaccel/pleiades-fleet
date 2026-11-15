/**
 * Twitter / X provider. Proxy hosts never match, so a link the user already
 * fixed is left untouched.
 *
 * With `apiBaseUrls` configured, the post is read from an FxTwitter-compatible
 * JSON API and becomes a custom card (`post`) carrying every media item, with
 * two exceptions:
 *   - a post whose only media is one video goes to the first proxy serving a
 *     playable `og:video`, because Discord plays a proxy's video at full
 *     quality while a bot can only upload a size-capped copy. A proxy shows a
 *     single media item, so posts with more media always get the card;
 *   - a possibly sensitive post is left to a proxy, so Discord applies each
 *     viewer's sensitive-media setting;
 *   - when no API answers, the provider behaves as if none were configured.
 * Without `apiBaseUrls`, every tweet is rewritten onto a validated proxy.
 *
 * With `gifBaseUrls` configured, each GIF is linked as an animated GIF
 * rendered by that conversion service (`{base}/tweet_video/{name}.gif`,
 * the FxTwitter convention), tried in order and confirmed before use; a GIF
 * no service renders stays an MP4 clip the renderer uploads.
 *
 * Proxy order matters: the FxEmbed family (`fxtwitter.com` and aliases)
 * publishes media via an `application/activity+json` link rather than
 * OpenGraph, so the probe grades its video tweets text-tier. Hosts serving
 * `og:video` must come first, or videos are re-uploaded instead of proxied.
 */
import { ok } from '../../../core/result';

import { fetchXStatus } from '../x-status';
import { createRewriteProbe } from './rewrite-provider';
import type { OgClient } from '../og-client';
import type { LinkPreviewBuildContext, LinkPreviewProvider, PostMedia } from '../types';

const PROVIDER_NAME = 'twitter';

const TWITTER_HOSTS: ReadonlySet<string> = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

/** `/<user>/status/<id>` or `/i/web/status/<id>` — rejects profiles/search. */
const STATUS_PATH = /\/status(?:es)?\/(\d+)/;

const matches = (url: URL): boolean =>
  TWITTER_HOSTS.has(url.hostname.toLowerCase()) && STATUS_PATH.test(url.pathname);

/** X's MP4 rendition of a GIF; the file name keys the conversion service's GIF. */
const GIF_MP4 = /^https:\/\/video\.twimg\.com\/tweet_video\/([\w-]+)\.mp4$/;

/** The first conversion service that renders `item` as a GIF, attached as its animation. */
const withAnimation = async (
  item: PostMedia,
  ogClient: OgClient,
  gifBaseUrls: readonly string[],
  ctx: LinkPreviewBuildContext,
): Promise<PostMedia> => {
  if (item.kind !== 'gif') return item;
  const name = item.variants
    .map((variant) => GIF_MP4.exec(variant.url)?.[1])
    .find((match) => match !== undefined);
  if (name === undefined) return item;
  for (const base of gifBaseUrls) {
    const gif = await ogClient.resolveGif(
      `${base.replace(/\/+$/, '')}/tweet_video/${name}.gif`,
      PROVIDER_NAME,
      ctx.timeoutMs,
    );
    if (gif.ok) return { ...item, animationUrl: gif.value };
    ctx.logger?.debug(
      { provider: PROVIDER_NAME, base, code: gif.error.code },
      'social-link-preview: gif conversion unavailable, trying next service',
    );
  }
  return item;
};

export const createTwitterProvider = (opts: {
  proxyHosts: readonly string[];
  ogClient: OgClient;
  /** FxTwitter-compatible API bases, tried in order; omit to proxy every tweet. */
  apiBaseUrls?: readonly string[];
  /** GIF conversion service bases, tried in order; omit to upload GIFs as MP4. */
  gifBaseUrls?: readonly string[];
}): LinkPreviewProvider => {
  const probe = createRewriteProbe({
    name: PROVIDER_NAME,
    matches,
    sourceDomains: ['twitter.com', 'x.com'],
    proxyHosts: opts.proxyHosts,
    ogClient: opts.ogClient,
    // Drop the query string (usually tracking params); the proxy needs only the path.
    toProxyUrl: (url, host) => `https://${host}${url.pathname}`,
  });
  const apiBaseUrls = opts.apiBaseUrls ?? [];
  const gifBaseUrls = opts.gifBaseUrls ?? [];

  return {
    name: PROVIDER_NAME,
    canHandle: matches,
    build: async (url, ctx) => {
      const proxied = async () => ok((await probe(url, ctx))?.preview ?? null);
      const id = STATUS_PATH.exec(url.pathname)?.[1];
      if (apiBaseUrls.length === 0 || id === undefined) return proxied();

      const status = await fetchXStatus(opts.ogClient, apiBaseUrls, id, ctx.timeoutMs);
      if (!status.ok) {
        ctx.logger?.debug(
          { provider: PROVIDER_NAME, code: status.error.code },
          'social-link-preview: x post API unavailable, falling back to a proxy link',
        );
        return proxied();
      }
      const { post, sensitive } = status.value;
      if (sensitive) return proxied();

      if (post.media.length === 1 && post.media[0]?.kind === 'video') {
        const candidate = await probe(url, ctx);
        if (candidate?.quality === 'video') return ok(candidate.preview);
      }
      const media =
        gifBaseUrls.length === 0
          ? post.media
          : await Promise.all(
              post.media.map((item) => withAnimation(item, opts.ogClient, gifBaseUrls, ctx)),
            );
      return ok({ kind: 'post' as const, post: { ...post, media }, sourceUrl: url.href });
    },
  };
};
