/**
 * Discord layout for a structured {@link SocialPost} (X): one Components V2
 * container with the author, text and counts above a gallery of every media
 * item, in post order. Photos show as themselves, GIFs as their animated
 * rendition, uploaded videos as playable attachments and any other clip as
 * its thumbnail. A container renders far wider than a classic embed and,
 * unlike one, can carry video.
 *
 * Post text is escaped so upstream content cannot inject Discord markdown
 * (headings, masked links, spoilers). Counts are compacted (`1.2K`) to match
 * the platform's own display.
 */
import { SOCIAL_COLORS } from './presentation-colors';
import {
  ContainerBuilder,
  MediaGalleryBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
} from 'discord.js';

import type { Translator } from '../../core/i18n';
import type { PostClip, PostMedia, PostVideoVariant, SocialPost } from '../link-preview';

/** Discord's item limit for one media gallery; an X post carries at most four. */
const MAX_GALLERY_ITEMS = 10;
const MAX_TEXT = 1500;
const MAX_QUOTE = 300;
/** Leaves room for container overhead, so an estimate near the cap is not tried. */
const SIZE_MARGIN = 0.9;
/** Upload attempts per post; each failed one costs a download. */
const MAX_VIDEO_ATTEMPTS = 2;

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const isHttps = (value: string | undefined): value is string =>
  value !== undefined && value.startsWith('https://');

const truncate = (text: string, max: number): string => {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 3).join('')}...`;
};

/**
 * Escape upstream text, including the line-start heading and masked-link
 * syntax that `escapeMarkdown` leaves alone by default: a post must not
 * render as a heading or hide a link target behind other text.
 */
const escapeText = (text: string): string =>
  escapeMarkdown(text, { heading: true, maskedLink: true });

const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const statsLine = (post: SocialPost, translator: Translator): string =>
  (['replies', 'reposts', 'likes', 'views'] as const)
    .flatMap((metric) => {
      const count = post.stats[metric];
      return count === undefined
        ? []
        : [
            translator.t(`replies:social_link_preview.post_${metric}`, {
              count: compactNumber.format(count),
            }),
          ];
    })
    .join(' · ');

/** Escaped post text, followed by the quoted post when there is one. */
const postBody = (post: SocialPost, translator: Translator): string => {
  const parts = [escapeText(truncate(post.text, MAX_TEXT))];
  if (post.quote !== undefined) {
    const header = translator.t('replies:social_link_preview.post_quote', {
      name: escapeText(post.quote.authorName),
      handle: post.quote.authorHandle,
      url: post.quote.url,
    });
    const text = escapeText(truncate(post.quote.text, MAX_QUOTE));
    parts.push(text.length > 0 ? `${header}\n${quoteLines(text)}` : header);
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
};

/**
 * What a gallery shows for an item it does not upload: the photo, a GIF's
 * animated rendition, or else a clip's thumbnail.
 */
export const mediaImageUrl = (item: PostMedia): string | undefined =>
  item.kind === 'photo' ? item.url : (item.animationUrl ?? item.thumbnailUrl);

/** A clip a gallery cannot play unless uploaded: a video, or a GIF without an animation. */
export const isStillClip = (item: PostMedia): item is PostClip =>
  item.kind !== 'photo' && item.animationUrl === undefined;

/**
 * A Components V2 card holding the post text and counts above its media.
 * `mediaUrls` are the gallery items in post order: `attachment://`
 * references of uploaded videos and image URLs for everything else.
 * `linkVideo` adds a link to watch a clip shown only as its thumbnail.
 * Exported for tests.
 */
export const buildPostContainer = (
  post: SocialPost,
  translator: Translator,
  mediaUrls: readonly string[],
  options: { readonly announcement?: string; readonly linkVideo?: boolean } = {},
): ContainerBuilder => {
  const { announcement } = options;
  const heading = `**[${escapeText(post.author.name)}](${post.author.url})** @${post.author.handle}`;
  let body = postBody(post, translator);
  if (options.linkVideo === true) {
    const watch = translator.t('replies:social_link_preview.post_watch_video', { url: post.url });
    body = body.length > 0 ? `${body}\n\n${watch}` : watch;
  }
  const header = new TextDisplayBuilder().setContent(
    body.length > 0 ? `${heading}\n${body}` : heading,
  );
  const footer = [
    statsLine(post, translator),
    `<t:${Math.floor(post.createdAt / 1000)}:f>`,
    translator.t('replies:social_link_preview.post_view_original', { url: post.url }),
  ]
    .filter((part) => part.length > 0)
    .join(' · ');

  const container = new ContainerBuilder().setAccentColor(SOCIAL_COLORS.x);
  if (announcement !== undefined) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(announcement));
  }
  const avatar = post.author.avatarUrl;
  if (isHttps(avatar)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(header)
        .setThumbnailAccessory((thumbnail) => thumbnail.setURL(avatar)),
    );
  } else {
    container.addTextDisplayComponents(header);
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  return mediaUrls.length === 0
    ? container
    : container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          mediaUrls.slice(0, MAX_GALLERY_ITEMS).map((url) => ({ media: { url } })),
        ),
      );
};

/**
 * The encodings worth downloading, best first: those whose estimated size
 * (bitrate × duration) fits under `maxBytes`, at most
 * {@link MAX_VIDEO_ATTEMPTS}. An unreported bitrate (0) always qualifies;
 * the downloader still enforces the real cap. Exported for tests.
 */
export const pickVideoVariants = (clip: PostClip, maxBytes: number): PostVideoVariant[] =>
  clip.variants
    .filter((variant) => (variant.bitrate * clip.durationSeconds) / 8 <= maxBytes * SIZE_MARGIN)
    .slice(0, MAX_VIDEO_ATTEMPTS);
