import { Collection, StickerFormatType, type Sticker } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { collectMedia } from '../../../../src/handlers/commands/menu_get_sticker/collect-media';

const sticker = (id: string, format: StickerFormatType) =>
  ({ id, name: `s${id}`, url: `https://media.example/${id}`, format }) as Sticker;

const source = (content: string, ...items: Sticker[]) => ({
  content,
  stickers: new Collection(items.map((item) => [item.id, item] as const)),
});

describe('collectMedia', () => {
  it('lists stickers, then every distinct custom emoji in the text', () => {
    const items = collectMedia([
      source(
        'hi <:cat:11> and <a:dance:22> and <:cat:11> again',
        sticker('1', StickerFormatType.PNG),
      ),
    ]);

    expect(items.map((item) => [item.kind, item.name, item.url])).toEqual([
      ['sticker', 's1', 'https://media.example/1?size=4096'],
      ['emoji', 'cat', 'https://cdn.discordapp.com/emojis/11.png?size=4096'],
      ['emoji', 'dance', 'https://cdn.discordapp.com/emojis/22.gif?size=4096'],
    ]);
  });

  it('requests the original size of a GIF sticker instead of the default thumbnail', () => {
    expect(collectMedia([source('', sticker('3', StickerFormatType.GIF))])[0]?.url).toBe(
      'https://media.example/3?size=4096',
    );
  });

  it('marks a Lottie sticker as not previewable and leaves its JSON link unsized', () => {
    expect(collectMedia([source('', sticker('2', StickerFormatType.Lottie))])[0]).toMatchObject({
      previewable: false,
      url: 'https://media.example/2',
    });
  });

  it('finds nothing in plain text', () => {
    expect(collectMedia([source('just words :smile:')])).toEqual([]);
  });

  it('reads forwarded snapshots after the message itself and drops repeats', () => {
    const items = collectMedia([
      source('look <:cat:11>'),
      source('<:cat:11> <:dog:33>', sticker('4', StickerFormatType.PNG)),
      source('', sticker('4', StickerFormatType.PNG)),
    ]);

    expect(items.map((item) => [item.kind, item.name])).toEqual([
      ['sticker', 's4'],
      ['emoji', 'cat'],
      ['emoji', 'dog'],
    ]);
  });
});
