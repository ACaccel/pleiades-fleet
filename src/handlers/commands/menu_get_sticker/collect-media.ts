import { StickerFormatType, type Collection, type Sticker } from 'discord.js';

/** One sticker or custom emoji the context menu can show. */
export interface MediaItem {
  readonly kind: 'sticker' | 'emoji';
  readonly name: string;
  readonly url: string;
  /** Lottie stickers are JSON animations Discord cannot show as an image. */
  readonly previewable: boolean;
}

/** Discord allows ten embeds per message. */
export const MAX_ITEMS = 10;

const CUSTOM_EMOJI = /<(a?):(\w+):(\d+)>/g;

/**
 * Without a size the CDN serves animated emoji and GIF stickers as 128px
 * thumbnails; the largest size returns the original and never upscales.
 */
const withOriginalSize = (url: string): string => {
  const sized = new URL(url);
  sized.searchParams.set('size', '4096');
  return sized.toString();
};

/** The parts of a message, or of a forwarded message snapshot, that can carry media. */
export interface MediaSource {
  readonly stickers: Collection<string, Sticker>;
  readonly content: string;
}

/**
 * Stickers first, then each distinct custom emoji in the text, in order of
 * appearance. Sources are read in order, so a message's own media precedes
 * the media of the messages it forwards; repeats across sources are dropped.
 */
export const collectMedia = (sources: readonly MediaSource[]): MediaItem[] => {
  const stickerIds = new Set<string>();
  const stickers: MediaItem[] = [];
  const emojiIds = new Set<string>();
  const emojis: MediaItem[] = [];
  for (const source of sources) {
    for (const sticker of source.stickers.values()) {
      if (stickerIds.has(sticker.id)) continue;
      stickerIds.add(sticker.id);
      const previewable = sticker.format !== StickerFormatType.Lottie;
      stickers.push({
        kind: 'sticker',
        name: sticker.name,
        url: previewable ? withOriginalSize(sticker.url) : sticker.url,
        previewable,
      });
    }
    for (const [, animated, name, id] of source.content.matchAll(CUSTOM_EMOJI)) {
      if (id === undefined || name === undefined || emojiIds.has(id)) continue;
      emojiIds.add(id);
      const extension = animated === 'a' ? 'gif' : 'png';
      emojis.push({
        kind: 'emoji',
        name,
        url: withOriginalSize(`https://cdn.discordapp.com/emojis/${id}.${extension}`),
        previewable: true,
      });
    }
  }
  return [...stickers, ...emojis];
};
