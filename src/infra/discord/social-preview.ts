/**
 * Render a static link preview through a Discord send or reply adapter.
 * Galleries are interactive and rendered by their own reader instead.
 *
 * This is the one place that branches on the result mechanism:
 *   - `rewritten-url`: reply with the proxy URL as plain content so
 *     Discord unfurls it into a (playable) embed;
 *   - `card`: a Components V2 card from the neutral OpenGraph card, its
 *     images below the metadata, or the video when a bounded download
 *     succeeds;
 *   - `post`: a custom X card (see `social-post.ts`) with every media item.
 *     Videos are uploaded, the largest encodings that fit together; one that
 *     cannot be uploaded shows its thumbnail and the card links the post.
 *
 * Custom cards are Components V2 containers rather than classic embeds:
 * Discord renders a container nearly twice as wide, so media shows larger
 * and less cropped. Their text is still derived from {@link buildCardEmbed}.
 *
 * Every reply uses `allowedMentions: { parse: [] }` so preview content
 * can never trigger an @everyone / @role ping (matches `llm-chat`).
 */
import { EMBED_COLORS, SOCIAL_COLORS } from './presentation-colors';
import {
  AttachmentBuilder,
  ContainerBuilder,
  DiscordAPIError,
  EmbedBuilder,
  HTTPError,
  MediaGalleryBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  type MessageCreateOptions,
} from 'discord.js';

import type { Translator } from '../../core/i18n';
import type {
  PostClip,
  PostMedia,
  PreviewCard,
  RenderablePreviewResult,
  SocialPost,
} from '../link-preview';
import { downloadPreviewVideo } from '../link-preview';
import { buildPostContainer, isStillClip, mediaImageUrl, pickVideoVariants } from './social-post';

export type PreviewSender = (payload: MessageCreateOptions) => Promise<unknown>;

const NO_MENTIONS = { parse: [] as const };
const DEFAULT_MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const DEFAULT_VIDEO_TIMEOUT_MS = 15_000;
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 350;
/** Discord's item limit for one Components V2 media gallery. */
const MAX_GALLERY_ITEMS = 10;
const COMPACT_COUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?[KMBT]$/i;

const isDisplayableCount = (count: number | string | undefined): count is number | string =>
  typeof count === 'number'
    ? Number.isSafeInteger(count) && count >= 0
    : typeof count === 'string' && COMPACT_COUNT.test(count);

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const prefix = text.slice(0, max - 3).replace(/[\uD800-\uDBFF]$/, '');
  return `${prefix}...`;
};

const truncateDescription = (text: string): string => {
  const characters = Array.from(text);
  return characters.length <= MAX_DESCRIPTION
    ? text
    : `${characters.slice(0, MAX_DESCRIPTION - 3).join('')}...`;
};

/** Build a static embed from a neutral preview card. Exported for tests. */
export const buildCardEmbed = (card: PreviewCard, translator: Translator): EmbedBuilder => {
  const facebook = card.siteName === 'Facebook';
  const embed = new EmbedBuilder().setColor(facebook ? SOCIAL_COLORS.facebook : EMBED_COLORS.info);
  if (facebook) {
    embed.setAuthor({
      name: 'Facebook',
      iconURL: 'https://www.facebook.com/images/fb_icon_325x325.png',
    });
  }
  const title = facebook ? card.authorName || card.title || 'Facebook' : card.title;
  if (title !== undefined && title.length > 0) {
    embed.setTitle(truncate(title, MAX_TITLE));
    embed.setURL(card.url);
  }
  if (card.description !== undefined && card.description.length > 0) {
    embed.setDescription(truncateDescription(card.description));
  }
  if (facebook) {
    const statistics = (['likes', 'comments', 'shares'] as const).flatMap((metric) => {
      const count = card.engagement?.[metric];
      return isDisplayableCount(count)
        ? [translator.t(`replies:social_link_preview.engagement_${metric}`, { count })]
        : [];
    });
    if (statistics.length > 0) embed.setFooter({ text: statistics.join(' · ') });
  }
  // Only set an https image: Discord requires it, and it prevents a
  // scraped page from injecting a non-https (or javascript:) image URL.
  if (card.imageUrl !== undefined && card.imageUrl.startsWith('https://')) {
    embed.setImage(card.imageUrl);
  }
  if (!facebook && card.siteName !== undefined && card.siteName.length > 0) {
    embed.setFooter({
      text: translator.t('replies:social_link_preview.embed_footer', { provider: card.siteName }),
    });
  }
  return embed;
};

const gallery = (urls: readonly string[]): MediaGalleryBuilder =>
  new MediaGalleryBuilder().addItems(
    urls.slice(0, MAX_GALLERY_ITEMS).map((url) => ({ media: { url } })),
  );

const isHttps = (url: string): boolean => url.startsWith('https://');

/**
 * A card as one Components V2 container: its metadata as text, then
 * `note` (a fallback link), then up to {@link MAX_GALLERY_ITEMS} media
 * items. A container renders far wider than a classic embed, so media
 * shows larger and less cropped. `announcement` leads, inside the card.
 */
const buildCardContainer = (
  card: PreviewCard,
  translator: Translator,
  mediaUrls: readonly string[],
  options: { readonly announcement?: string; readonly note?: string } = {},
): ContainerBuilder => {
  const embed = buildCardEmbed({ ...card, imageUrl: undefined }, translator).toJSON();
  const escapeText = (text: string): string =>
    escapeMarkdown(text, { heading: true, maskedLink: true });
  const container = new ContainerBuilder().setAccentColor(embed.color ?? EMBED_COLORS.info);
  const text = [
    options.announcement,
    embed.author === undefined ? undefined : `**${escapeText(embed.author.name)}**`,
    embed.title === undefined ? undefined : `**[${escapeText(embed.title)}](${card.url})**`,
    embed.description === undefined ? undefined : escapeText(embed.description),
    embed.footer === undefined ? undefined : `-# ${escapeText(embed.footer.text)}`,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  if (embed.title === undefined) text.push(`<${card.url}>`);
  if (options.note !== undefined) text.push(options.note);
  for (const content of text) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  }
  return mediaUrls.length === 0
    ? container
    : container.addMediaGalleryComponents(gallery(mediaUrls));
};

export interface PreviewRenderOptions {
  /** Localized feed announcement, included in the same delivery as the preview. */
  readonly announcement?: string;
  readonly maxVideoBytes?: number;
  readonly videoTimeoutMs?: number;
  readonly downloadVideo?: (
    url: string,
    maxBytes: number,
    timeoutMs: number,
  ) => Promise<{ data: Buffer; name: string } | null>;
}

/**
 * Send a card with every distinct HTTPS image: the first gallery inside the
 * card, the rest in follow-up gallery messages of {@link MAX_GALLERY_ITEMS}.
 */
const replyWithCard = async (
  send: PreviewSender,
  card: PreviewCard,
  translator: Translator,
  options: { readonly announcement?: string; readonly note?: string },
): Promise<void> => {
  const images = [
    ...new Set([...(card.imageUrl ? [card.imageUrl] : []), ...(card.imageUrls ?? [])]),
  ].filter(isHttps);
  await send({
    flags: MessageFlags.IsComponentsV2,
    components: [buildCardContainer(card, translator, images, options)],
    allowedMentions: NO_MENTIONS,
  });
  for (let offset = MAX_GALLERY_ITEMS; offset < images.length; offset += MAX_GALLERY_ITEMS) {
    await send({
      flags: MessageFlags.IsComponentsV2,
      components: [gallery(images.slice(offset))],
      allowedMentions: NO_MENTIONS,
    });
  }
};

const isUploadRejection = (error: unknown): boolean =>
  (error instanceof DiscordAPIError &&
    (error.code === 40005 ||
      error.code === 50045 ||
      error.code === 50013 ||
      error.status === 413)) ||
  (error instanceof HTTPError && error.status === 413);

/** Extension of a downloaded file name, defaulting to `mp4`. */
const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'mp4';

/** A clip the bot must upload to show playing: one without an animated rendition. */
const needsUpload = (item: PostMedia): item is PostClip =>
  item.kind !== 'photo' && item.animationUrl === undefined && item.variants.length > 0;

/**
 * Download attempt `attempt` of a post's media: each clip to upload takes
 * its `attempt`-th encoding that fits what earlier uploads left of
 * `maxBytes`, since one message carries them all. Other items, and clips
 * with no such encoding or a failed download, keep their image URL.
 */
const downloadPostMedia = async (
  post: SocialPost,
  attempt: number,
  options: PreviewRenderOptions,
): Promise<{ urls: string[]; files: AttachmentBuilder[]; tried: boolean; still: boolean }> => {
  const download = options.downloadVideo ?? downloadPreviewVideo;
  let remaining = options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
  const urls: string[] = [];
  const files: AttachmentBuilder[] = [];
  let tried = false;
  let still = false;
  for (const [index, item] of post.media.entries()) {
    const variant = needsUpload(item) ? pickVideoVariants(item, remaining)[attempt] : undefined;
    tried ||= variant !== undefined;
    const video =
      variant === undefined
        ? null
        : await download(
            variant.url,
            remaining,
            options.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
          ).catch(() => null);
    if (video === null) {
      const image = mediaImageUrl(item);
      if (image !== undefined && isHttps(image)) urls.push(image);
      still ||= isStillClip(item);
      continue;
    }
    const name = `x-media-${index + 1}.${extensionOf(video.name)}`;
    files.push(new AttachmentBuilder(video.data, { name }));
    urls.push(`attachment://${name}`);
    remaining -= video.data.length;
  }
  return { urls, files, tried, still };
};

/**
 * Reply with a custom X card holding every media item. When clips have to
 * be uploaded to play, each takes its best encoding that fits, then the next
 * one down when downloads or the upload fail; with nothing uploadable every
 * item shows as an image and a clip that cannot play links the post.
 */
const renderPost = async (
  send: PreviewSender,
  post: SocialPost,
  translator: Translator,
  options: PreviewRenderOptions,
): Promise<void> => {
  const reply = (urls: readonly string[], files: AttachmentBuilder[], linkVideo: boolean) =>
    send({
      flags: MessageFlags.IsComponentsV2,
      components: [
        buildPostContainer(post, translator, urls, {
          linkVideo,
          ...(options.announcement === undefined ? {} : { announcement: options.announcement }),
        }),
      ],
      ...(files.length === 0 ? {} : { files }),
      allowedMentions: NO_MENTIONS,
    });
  if (post.media.some(needsUpload)) {
    for (let attempt = 0; ; attempt += 1) {
      const { urls, files, tried, still } = await downloadPostMedia(post, attempt, options);
      if (!tried) break;
      if (files.length === 0) continue;
      try {
        await reply(urls, files, still);
        return;
      } catch (error) {
        if (!isUploadRejection(error)) throw error;
      }
    }
  }
  const images = post.media.flatMap((item) => {
    const image = mediaImageUrl(item);
    return image !== undefined && isHttps(image) ? [image] : [];
  });
  await reply(images, [], post.media.some(isStillClip));
};

export const renderPreviewTo = async (
  send: PreviewSender,
  result: RenderablePreviewResult,
  translator: Translator,
  options: PreviewRenderOptions = {},
): Promise<void> => {
  if (result.kind === 'rewritten-url') {
    await send({ content: options.announcement ?? result.url, allowedMentions: NO_MENTIONS });
    return;
  }
  if (result.kind === 'post') {
    await renderPost(send, result.post, translator, options);
    return;
  }
  if (result.media !== undefined) {
    const maxBytes = options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
    const download = options.downloadVideo ?? downloadPreviewVideo;
    const video = await download(
      result.media.url,
      maxBytes,
      options.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    ).catch(() => null);
    if (video !== null) {
      // A carousel keeps its images ahead of the video; a lone image is the
      // video's poster frame and is dropped.
      const images = (result.card.imageUrls ?? []).filter(isHttps).slice(0, MAX_GALLERY_ITEMS - 1);
      try {
        await send({
          flags: MessageFlags.IsComponentsV2,
          components: [
            buildCardContainer(
              result.card,
              translator,
              [...images, `attachment://${video.name}`],
              options.announcement === undefined ? {} : { announcement: options.announcement },
            ),
          ],
          files: [new AttachmentBuilder(video.data, { name: video.name })],
          allowedMentions: NO_MENTIONS,
        });
        return;
      } catch (error) {
        if (!isUploadRejection(error)) throw error;
      }
    }
    await replyWithCard(send, result.card, translator, {
      ...(options.announcement === undefined ? {} : { announcement: options.announcement }),
      note: `<${result.media.fallbackUrl}>`,
    });
    return;
  }
  await replyWithCard(
    send,
    result.card,
    translator,
    options.announcement === undefined ? {} : { announcement: options.announcement },
  );
};
