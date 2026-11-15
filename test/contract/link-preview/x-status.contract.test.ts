/**
 * Contract test for the X post API path: real axios through
 * {@link OgClient.fetchJson}, with the HTTP boundary pinned by nock. Covers
 * the request shape (v2 endpoint, JSON accept, descriptive UA), HTTP error
 * mapping, the redirect SSRF guard, and the base-URL fallback; and the GIF
 * conversion check through {@link OgClient.resolveGif}.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { OgClient } from '../../../src/infra/link-preview';
import { isErr, isOk } from '../../../src/core/result';
import { fetchXStatus } from '../../../src/infra/link-preview/x-status';

const PRIMARY = 'https://api.primary.test';
const BACKUP = 'https://api.backup.test';
const PATH = '/2/status/42';

const BODY = {
  code: 200,
  status: {
    url: 'https://x.com/NASA/status/42',
    text: 'hello',
    created_timestamp: 1,
    author: { name: 'NASA', screen_name: 'NASA' },
    likes: 5,
  },
};

describe('x status API contract', () => {
  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('reads the v2 status endpoint with a JSON accept and an attributable UA', async () => {
    nock(PRIMARY, {
      reqheaders: {
        accept: 'application/json',
        'user-agent': (value) => value.startsWith('Pleiades-link-preview/'),
      },
    })
      .get(PATH)
      .reply(200, BODY);

    const result = await fetchXStatus(new OgClient(), [PRIMARY], '42', 1000);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.post.stats).toEqual({ likes: 5 });
  });

  it('falls back to the next base after an HTTP error', async () => {
    nock(PRIMARY).get(PATH).reply(503, { code: 503 });
    nock(BACKUP).get(PATH).reply(200, BODY);

    const result = await fetchXStatus(new OgClient(), [PRIMARY, BACKUP], '42', 1000);
    expect(isOk(result)).toBe(true);
  });

  it('maps a 404 body to a fetch failure', async () => {
    nock(PRIMARY).get(PATH).reply(404, { code: 404, message: 'NOT_FOUND' });

    const result = await new OgClient().fetchJson(`${PRIMARY}${PATH}`, 'twitter', 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_FETCH_FAILED');
  });

  it('refuses a redirect to an internal address', async () => {
    nock(PRIMARY)
      .get(PATH)
      .reply(302, '', { Location: 'http://169.254.169.254/latest/meta-data/' });

    const result = await new OgClient().fetchJson(`${PRIMARY}${PATH}`, 'twitter', 1000);
    expect(isErr(result)).toBe(true);
  });
});

describe('gif conversion contract', () => {
  const GIF_BASE = 'https://gif.convert.test';
  const GIF_PATH = '/tweet_video/Abc.gif';

  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('returns the served URL of a GIF, following a redirect', async () => {
    nock(GIF_BASE, { reqheaders: { accept: 'image/gif' } })
      .get(GIF_PATH)
      .reply(302, '', { Location: 'https://cdn.convert.test/Abc.gif' });
    nock('https://cdn.convert.test')
      .get('/Abc.gif')
      .reply(200, 'GIF89a', { 'Content-Type': 'image/gif' });

    const result = await new OgClient().resolveGif(`${GIF_BASE}${GIF_PATH}`, 'twitter', 1000);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('https://cdn.convert.test/Abc.gif');
  });

  it('rejects a response that is not a GIF', async () => {
    nock(GIF_BASE).get(GIF_PATH).reply(200, '<html></html>', { 'Content-Type': 'text/html' });

    const result = await new OgClient().resolveGif(`${GIF_BASE}${GIF_PATH}`, 'twitter', 1000);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_INVALID_RESPONSE');
  });

  it('maps an HTTP error and refuses a redirect to an internal address', async () => {
    nock(GIF_BASE).get(GIF_PATH).reply(502);
    nock(GIF_BASE)
      .get('/tweet_video/Def.gif')
      .reply(302, '', { Location: 'http://127.0.0.1/x.gif' });

    const client = new OgClient();
    expect(isErr(await client.resolveGif(`${GIF_BASE}${GIF_PATH}`, 'twitter', 1000))).toBe(true);
    expect(isErr(await client.resolveGif(`${GIF_BASE}/tweet_video/Def.gif`, 'twitter', 1000))).toBe(
      true,
    );
  });
});
