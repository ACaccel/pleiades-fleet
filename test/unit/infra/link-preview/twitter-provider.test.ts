/**
 * Unit tests for the X provider's choice between its custom card and an
 * embed proxy: without an API, or when the API fails, every tweet is
 * proxied; a sensitive post is proxied; a post without video becomes a
 * card; a post whose only media is a video is proxied only when a proxy
 * serves a playable video, any other post becomes a card with every item;
 * and a GIF gains the animation of the first conversion service that
 * renders it.
 */
import { describe, expect, it, vi } from 'vitest';

import { err, isOk, ok } from '../../../../src/core/result';
import {
  createTwitterProvider,
  invalidResponseError,
  type LinkPreviewResult,
  type OgClient,
  type OpenGraphMeta,
} from '../../../../src/infra/link-preview';

const TWEET = 'https://x.com/NASA/status/42?s=20';
const API = 'https://api.example/2/status/42';
const PROXY = 'https://vxtwitter.com/NASA/status/42';

const status = (extra: Record<string, unknown> = {}): unknown => ({
  status: {
    url: 'https://x.com/NASA/status/42',
    text: 'hello',
    created_timestamp: 1,
    author: { name: 'NASA', screen_name: 'NASA' },
    ...extra,
  },
});

const VIDEO_MEDIA = {
  media: {
    videos: [
      {
        duration: 10,
        formats: [{ url: 'https://video.twimg.com/v.mp4', container: 'mp4', bitrate: 800_000 }],
      },
    ],
  },
};

const GIF_MEDIA = {
  media: {
    all: [
      { type: 'photo', url: 'https://pbs.twimg.com/1.jpg' },
      {
        type: 'gif',
        duration: 0,
        formats: [{ url: 'https://video.twimg.com/tweet_video/Abc-1.mp4', container: 'mp4' }],
      },
    ],
  },
};

const makeClient = (opts: {
  json?: unknown;
  proxy?: OpenGraphMeta;
  gifs?: Record<string, string>;
}): {
  client: OgClient;
  fetch: ReturnType<typeof vi.fn>;
  fetchJson: ReturnType<typeof vi.fn>;
  resolveGif: ReturnType<typeof vi.fn>;
} => {
  const fetchJson = vi.fn(async (url: string) =>
    url === API && opts.json !== undefined ? ok(opts.json) : err(invalidResponseError('twitter')),
  );
  const fetch = vi.fn(async (url: string) =>
    url === PROXY && opts.proxy !== undefined
      ? ok(opts.proxy)
      : err(invalidResponseError('twitter')),
  );
  const resolveGif = vi.fn(async (url: string) => {
    const resolved = opts.gifs?.[url];
    return resolved === undefined ? err(invalidResponseError('twitter')) : ok(resolved);
  });
  return {
    client: { fetch, fetchJson, resolveGif } as unknown as OgClient,
    fetch,
    fetchJson,
    resolveGif,
  };
};

const build = async (
  client: OgClient,
  apiBaseUrls?: string[],
  gifBaseUrls?: string[],
): Promise<LinkPreviewResult | null> => {
  const provider = createTwitterProvider({
    proxyHosts: ['vxtwitter.com'],
    ogClient: client,
    ...(apiBaseUrls === undefined ? {} : { apiBaseUrls }),
    ...(gifBaseUrls === undefined ? {} : { gifBaseUrls }),
  });
  const result = await provider.build(new URL(TWEET), { timeoutMs: 1000 });
  if (!isOk(result)) throw new Error('expected ok');
  return result.value;
};

const rewritten = { kind: 'rewritten-url', url: PROXY, sourceUrl: TWEET };

describe('twitter provider custom card', () => {
  it('proxies every tweet when no API is configured', async () => {
    const { client, fetchJson } = makeClient({ proxy: { images: ['https://i/1.jpg'] } });
    expect(await build(client)).toEqual(rewritten);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('falls back to the proxy when the API fails', async () => {
    const { client } = makeClient({ proxy: { images: ['https://i/1.jpg'] } });
    expect(await build(client, ['https://api.example'])).toEqual(rewritten);
  });

  it('returns null when both the API and every proxy fail', async () => {
    const { client } = makeClient({});
    expect(await build(client, ['https://api.example'])).toBeNull();
  });

  it('leaves a possibly sensitive post to the proxy', async () => {
    const { client } = makeClient({
      json: status({ possibly_sensitive: true }),
      proxy: { images: ['https://i/1.jpg'] },
    });
    expect(await build(client, ['https://api.example'])).toEqual(rewritten);
  });

  it('renders a post without video as a card, without probing a proxy', async () => {
    const { client, fetch } = makeClient({ json: status() });
    const result = await build(client, ['https://api.example']);
    expect(result?.kind).toBe('post');
    if (result?.kind === 'post') {
      expect(result.post.text).toBe('hello');
      expect(result.sourceUrl).toBe(TWEET);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('proxies a video post when a proxy serves a playable video', async () => {
    const { client } = makeClient({
      json: status(VIDEO_MEDIA),
      proxy: { images: [], video: 'https://cdn/v.mp4' },
    });
    expect(await build(client, ['https://api.example'])).toEqual(rewritten);
  });

  it('renders a video post as a card when the proxy offers only an image', async () => {
    const { client } = makeClient({
      json: status(VIDEO_MEDIA),
      proxy: { title: 'NASA', images: ['https://i/thumb.jpg'] },
    });
    const result = await build(client, ['https://api.example']);
    expect(result?.kind).toBe('post');
    if (result?.kind === 'post') expect(result.post.media).toMatchObject([{ kind: 'video' }]);
  });

  it('renders a post with more than one media item as a card without probing a proxy', async () => {
    const { client, fetch } = makeClient({
      json: status({
        media: {
          all: [{ type: 'photo', url: 'https://pbs.twimg.com/1.jpg' }, ...VIDEO_MEDIA.media.videos],
        },
      }),
      proxy: { images: [], video: 'https://cdn/v.mp4' },
    });
    const result = await build(client, ['https://api.example']);
    expect(result?.kind).toBe('post');
    if (result?.kind === 'post') {
      expect(result.post.media.map((item) => item.kind)).toEqual(['photo', 'video']);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('twitter provider GIF animation', () => {
  it('attaches the first conversion service that renders the GIF', async () => {
    const { client, resolveGif } = makeClient({
      json: status(GIF_MEDIA),
      gifs: { 'https://gif-b.example/tweet_video/Abc-1.gif': 'https://cdn.gif-b/Abc-1.gif' },
    });
    const result = await build(
      client,
      ['https://api.example'],
      ['https://gif-a.example', 'https://gif-b.example/'],
    );
    expect(resolveGif.mock.calls.map(([url]) => url)).toEqual([
      'https://gif-a.example/tweet_video/Abc-1.gif',
      'https://gif-b.example/tweet_video/Abc-1.gif',
    ]);
    if (result?.kind !== 'post') throw new Error('expected a post');
    expect(result.post.media).toEqual([
      { kind: 'photo', url: 'https://pbs.twimg.com/1.jpg' },
      {
        kind: 'gif',
        durationSeconds: 0,
        variants: [{ url: 'https://video.twimg.com/tweet_video/Abc-1.mp4', bitrate: 0 }],
        animationUrl: 'https://cdn.gif-b/Abc-1.gif',
      },
    ]);
  });

  it('keeps the GIF as an uploadable clip when no service renders it', async () => {
    const { client } = makeClient({ json: status(GIF_MEDIA) });
    const result = await build(client, ['https://api.example'], ['https://gif-a.example']);
    if (result?.kind !== 'post') throw new Error('expected a post');
    expect(result.post.media[1]).not.toHaveProperty('animationUrl');
  });

  it('asks no service without configured bases or for a non-GIF clip URL', async () => {
    const { client, resolveGif } = makeClient({ json: status(GIF_MEDIA) });
    await build(client, ['https://api.example']);
    const other = makeClient({
      json: status({
        media: {
          all: [{ type: 'gif', formats: [{ url: 'https://cdn.example/g.mp4', container: 'mp4' }] }],
        },
      }),
    });
    await build(other.client, ['https://api.example'], ['https://gif-a.example']);
    expect(resolveGif).not.toHaveBeenCalled();
    expect(other.resolveGif).not.toHaveBeenCalled();
  });
});
