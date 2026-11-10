import { Collection, StickerFormatType, type Sticker } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { collectMedia } from '../../../../src/handlers/commands/menu_get_sticker/collect-media';

const sticker = (id: string, format: StickerFormatType) =>
  ({ id, name: `s${id}`, url: `https://media.example/${id}`, format }) as Sticker;

describe('collectMedia', () => {
  it('lists stickers, then every distinct custom emoji in the text', () => {
    const stickers = new Collection([['1', sticker('1', StickerFormatType.PNG)]]);

    const items = collectMedia(stickers, 'hi <:cat:11> and <a:dance:22> and <:cat:11> again');

    expect(items.map((item) => [item.kind, item.name, item.url])).toEqual([
      ['sticker', 's1', 'https://media.example/1?size=4096'],
      ['emoji', 'cat', 'https://cdn.discordapp.com/emojis/11.png?size=4096'],
      ['emoji', 'dance', 'https://cdn.discordapp.com/emojis/22.gif?size=4096'],
    ]);
  });

  it('requests the original size of a GIF sticker instead of the default thumbnail', () => {
    const stickers = new Collection([['3', sticker('3', StickerFormatType.GIF)]]);

    expect(collectMedia(stickers, '')[0]?.url).toBe('https://media.example/3?size=4096');
  });

  it('marks a Lottie sticker as not previewable and leaves its JSON link unsized', () => {
    const stickers = new Collection([['2', sticker('2', StickerFormatType.Lottie)]]);

    expect(collectMedia(stickers, '')[0]).toMatchObject({
      previewable: false,
      url: 'https://media.example/2',
    });
  });

  it('finds nothing in plain text', () => {
    expect(collectMedia(new Collection(), 'just words :smile:')).toEqual([]);
  });
});
