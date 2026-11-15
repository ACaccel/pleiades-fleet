/**
 * Unit tests for the custom X card layout: the Components V2 card (author,
 * escaped text, quote, compact counts, timestamp, a link for an unplayable
 * clip, the media gallery last) and the choice of which video encodings to
 * try. Which URL each media item contributes is covered by the renderer
 * tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { ComponentType } from 'discord.js';

import type { Translator } from '../../../../src/core/i18n';
import type { PostClip, SocialPost } from '../../../../src/infra/link-preview';
import { echoTranslator } from '../../../fixtures/runtime';
import {
  buildPostContainer,
  pickVideoVariants,
} from '../../../../src/plugins/social-link-preview/internal/render-post';

/** Echoes the key's last segment and its params, so assertions see both. */
const translator: Translator = {
  ...echoTranslator(),
  t: vi.fn((key: string, params?: Record<string, unknown>) => {
    const name = key.split('.').pop() ?? key;
    return params === undefined ? name : `${name}(${Object.values(params).join(',')})`;
  }),
};

const post = (extra: Partial<SocialPost> = {}): SocialPost => ({
  url: 'https://x.com/NASA/status/1',
  text: 'Welcome home!',
  createdAt: 1_791_840_744_000,
  author: {
    name: 'NASA',
    handle: 'NASA',
    url: 'https://x.com/NASA',
    avatarUrl: 'https://pbs.twimg.com/a.jpg',
  },
  media: [],
  stats: { replies: 196, reposts: 847, likes: 6500, views: 1_500_000 },
  ...extra,
});

/** The text beside the avatar: heading, then the escaped body. */
const headerText = (container: ReturnType<typeof buildPostContainer>): string | undefined => {
  const [first] = container.toJSON().components;
  if (first?.type === ComponentType.Section) return first.components[0]?.content;
  return first?.type === ComponentType.TextDisplay ? first.content : undefined;
};

describe('buildPostContainer', () => {
  it('escapes markdown in the post text', () => {
    const container = buildPostContainer(
      post({ text: '# big\n||spoiler|| **bold** [x.com](https://evil.test)' }),
      translator,
      [],
    );
    expect(headerText(container)).toBe(
      '**[NASA](https://x.com/NASA)** @NASA\n\\# big\n\\|\\|spoiler\\|\\| \\*\\*bold\\*\\* \\[x.com](https://evil.test)',
    );
  });

  it('appends the quoted post as a block quote', () => {
    const container = buildPostContainer(
      post({
        quote: {
          url: 'https://x.com/s/status/2',
          text: 'line one\nline two',
          authorName: 'Someone',
          authorHandle: 's',
        },
      }),
      translator,
      [],
    );
    expect(headerText(container)).toBe(
      '**[NASA](https://x.com/NASA)** @NASA\nWelcome home!\n\npost_quote(Someone,s,https://x.com/s/status/2)\n> line one\n> line two',
    );
  });

  it('links the post to watch a clip shown only as its thumbnail', () => {
    const container = buildPostContainer(post(), translator, ['https://pbs.twimg.com/t.jpg'], {
      linkVideo: true,
    });
    expect(headerText(container)).toBe(
      '**[NASA](https://x.com/NASA)** @NASA\nWelcome home!\n\npost_watch_video(https://x.com/NASA/status/1)',
    );
  });

  it('omits unreported counts and the gallery of a post without media', () => {
    const json = buildPostContainer(post({ stats: {} }), translator, []).toJSON();
    expect(json.components.map((component) => component.type)).toEqual([
      ComponentType.Section,
      ComponentType.TextDisplay,
    ]);
    expect(json.components[1]).toMatchObject({
      content: '-# <t:1791840744:f> · post_view_original(https://x.com/NASA/status/1)',
    });
  });

  it('leads with the announcement', () => {
    const json = buildPostContainer(post(), translator, [], { announcement: 'New post' }).toJSON();
    expect(json.components[0]).toEqual({ type: ComponentType.TextDisplay, content: 'New post' });
  });

  it('puts the text beside the avatar, then the counts, then the media last', () => {
    const json = buildPostContainer(post(), translator, [
      'https://pbs.twimg.com/1.jpg',
      'attachment://x-media-2.mp4',
    ]).toJSON();
    expect(json.accent_color).toBe(0x1d9bf0);
    const [section, footer, gallery] = json.components;
    expect(section?.type).toBe(ComponentType.Section);
    if (section?.type === ComponentType.Section) {
      expect(section.components[0]?.content).toBe(
        '**[NASA](https://x.com/NASA)** @NASA\nWelcome home!',
      );
      expect(section.accessory).toMatchObject({ media: { url: 'https://pbs.twimg.com/a.jpg' } });
    }
    expect(gallery).toMatchObject({
      type: ComponentType.MediaGallery,
      items: [
        { media: { url: 'https://pbs.twimg.com/1.jpg' } },
        { media: { url: 'attachment://x-media-2.mp4' } },
      ],
    });
    expect(footer).toMatchObject({
      type: ComponentType.TextDisplay,
      content:
        '-# post_replies(196) · post_reposts(847) · post_likes(6.5K) · post_views(1.5M) · <t:1791840744:f> · post_view_original(https://x.com/NASA/status/1)',
    });
  });

  it('uses a plain text block when the author has no avatar', () => {
    const { avatarUrl: _omitted, ...author } = post().author;
    const json = buildPostContainer(post({ author }), translator, ['attachment://v.mp4']).toJSON();
    expect(json.components[0]?.type).toBe(ComponentType.TextDisplay);
  });
});

describe('pickVideoVariants', () => {
  const video: PostClip = {
    kind: 'video',
    durationSeconds: 100,
    variants: [
      { url: 'https://v/high.mp4', bitrate: 2_000_000 },
      { url: 'https://v/mid.mp4', bitrate: 700_000 },
      { url: 'https://v/low.mp4', bitrate: 250_000 },
      { url: 'https://v/tiny.mp4', bitrate: 100_000 },
    ],
  };

  it('keeps the encodings estimated to fit, best first, at most two', () => {
    // 8 MiB cap with a 90% margin (7.5 MB): high = 25 MB and mid = 8.75 MB are over.
    expect(pickVideoVariants(video, 8 * 1024 * 1024).map((v) => v.url)).toEqual([
      'https://v/low.mp4',
      'https://v/tiny.mp4',
    ]);
  });

  it('returns nothing when no encoding fits', () => {
    expect(pickVideoVariants(video, 100_000)).toEqual([]);
  });

  it('leaves an encoding without a bitrate to the download cap', () => {
    const gif: PostClip = {
      kind: 'gif',
      durationSeconds: 0,
      variants: [{ url: 'https://v/gif.mp4', bitrate: 0 }],
    };
    expect(pickVideoVariants(gif, 100_000).map((v) => v.url)).toEqual(['https://v/gif.mp4']);
  });
});
