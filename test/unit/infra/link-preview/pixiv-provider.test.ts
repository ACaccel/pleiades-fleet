import { describe, expect, it, vi } from 'vitest';

import {
  createPixivProvider,
  invalidResponseError,
  type OgClient,
  type OpenGraphMeta,
} from '../../../../src/infra/link-preview';
import { err, ok } from '../../../../src/core/result';

const artworkUrls = [
  'https://www.pixiv.net/artworks/123456789',
  'https://pixiv.net/artworks/123456789/?utm_source=share#fragment',
  'https://www.pixiv.net/en/artworks/123456789',
  'https://www.pixiv.net/zh-tw/artworks/123456789',
  'https://m.pixiv.net/i/123456789',
  'https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123456789',
];

const setup = () => {
  const fetch = vi
    .fn<OgClient['fetch']>()
    .mockResolvedValue(
      ok({ title: 'Artwork', images: ['https://images.example/art.jpg'] } as OpenGraphMeta),
    );
  const provider = createPixivProvider({
    proxyHosts: ['phixiv.net', 'ppxiv.net'],
    ogClient: { fetch } as unknown as OgClient,
  });
  return { provider, fetch };
};

describe('Pixiv provider', () => {
  it.each(artworkUrls)(
    'normalizes artwork link %s without leaking tracking parameters',
    async (href) => {
      const { provider, fetch } = setup();
      const url = new URL(href);
      expect(provider.canHandle(url)).toBe(true);
      expect(await provider.build(url, { timeoutMs: 1234 })).toEqual(
        ok({
          kind: 'rewritten-url',
          url: 'https://phixiv.net/artworks/123456789',
          sourceUrl: href,
        }),
      );
      expect(fetch.mock.calls).toEqual([
        ['https://phixiv.net/artworks/123456789', 'pixiv', 1234],
        ['https://ppxiv.net/artworks/123456789', 'pixiv', 1234],
      ]);
    },
  );

  it.each([
    'https://www.pixiv.net/',
    'https://www.pixiv.net/users/123',
    'https://www.pixiv.net/novel/show.php?id=123',
    'https://www.pixiv.net/artworks/0',
    'https://www.pixiv.net/artworks/not-an-id',
    'https://www.pixiv.net/artworks/123/extra',
    'https://www.pixiv.net/member_illust.php',
    'https://www.pixiv.net/member_illust.php?illust_id=abc',
    'https://www.pixiv.net/i/',
    'https://www.pixiv.net.evil.example/artworks/123',
    'https://evil.pixiv.net/artworks/123',
    'https://phixiv.net/artworks/123',
    'ftp://www.pixiv.net/artworks/123',
  ])('ignores non-artwork or untrusted URL %s', (href) => {
    const { provider, fetch } = setup();
    expect(provider.canHandle(new URL(href))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the next proxy when the first fails', async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValueOnce(err(invalidResponseError('pixiv')));
    expect(await provider.build(new URL(artworkUrls[0]!), { timeoutMs: 1000 })).toMatchObject({
      ok: true,
      value: { kind: 'rewritten-url', url: 'https://ppxiv.net/artworks/123456789' },
    });
  });

  it('skips unavailable artwork instead of posting a broken proxy link', async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(err(invalidResponseError('pixiv')));
    expect(await provider.build(new URL(artworkUrls[0]!), { timeoutMs: 1000 })).toEqual(ok(null));
  });

  it('rejects a proxy that redirects to Pixiv even when the source has media', async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(
      ok({ images: ['https://images.example/art.jpg'], finalUrl: artworkUrls[0] }),
    );
    expect(await provider.build(new URL(artworkUrls[0]!), { timeoutMs: 1000 })).toEqual(ok(null));
  });
});
