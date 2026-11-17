/**
 * Server-sticker dashboard in two columns: the summary tiles
 * above the pictures of stickers nobody used, beside a grid of ranked sticker
 * cards (art, name, count with share, usage bar relative to the top
 * sticker). Four to six cards a row, whichever Discord shows largest in its
 * 4:3 image box, so a long ranking grows wider instead of into a tall strip.
 */
import { roundRect } from '../canvas-primitives';
import { drawArt } from './art';
import { largestInEmbed, renderColumns } from './columns';
import { TITLE_HEIGHT, sectionTitle, type Block, type Column, type Ctx } from './layout';
import { drawFitted, drawText, fitText, textWidth } from './text';
import { COLOR, formatCount, formatPercent } from './theme';
import { tileRows } from './tiles';
import type { StickerDashboard, StickerRanking, StickerRankRow } from './types';
import { unusedBlocks } from './unused';

/** Cards a row to choose from. */
const COLUMN_CHOICES = [4, 5, 6] as const;
/** Cards drawn when the member does not choose: three rows of four. */
export const STICKER_DEFAULT_CARDS = 12;
/** The most cards a ranking draws: five rows of six. */
export const STICKER_RANK_LIMIT = 30;

const GAP = 8;
const CARD_WIDTH = 116;
const CARD_HEIGHT = 138;
/** The image is wider than 4:3, so narrow columns enlarge the displayed text. */
const SUMMARY_WIDTH = 200;
/** Picture rows that keep the summary column no taller than a default grid. */
const UNUSED_ROWS = 6;
const UNUSED_SIZE = 36;
const ART_SIZE = 70;
const NOTE_HEIGHT = 22;

interface CardContext {
  readonly caption: StickerRanking['countCaption'];
  readonly totalUses: number;
  readonly max: number;
}

const drawCard = (
  ctx: Ctx,
  row: StickerRankRow,
  rank: number,
  card: CardContext,
  x: number,
  y: number,
): void => {
  roundRect(ctx, x, y, CARD_WIDTH, CARD_HEIGHT, 8);
  ctx.fillStyle = COLOR.tile;
  ctx.fill();
  const initials = Array.from(row.name).slice(0, 1).join('');
  drawArt(
    ctx,
    { image: row.image, name: row.name, initials },
    x + (CARD_WIDTH - ART_SIZE) / 2,
    y + 12,
    ART_SIZE,
    12,
  );
  ctx.beginPath();
  ctx.arc(x + 13, y + 13, 9, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.embedBg;
  ctx.fill();
  drawText(ctx, String(rank), x + 13, y + 13.5, { size: 12, color: COLOR.body, align: 'center' });
  const center = { size: 13, color: COLOR.ink, align: 'center' } as const;
  drawFitted(ctx, row.name, x + CARD_WIDTH / 2, y + 98, CARD_WIDTH - 12, center);
  const count = formatCount(row.count);
  const countW = textWidth(ctx, count, 14);
  const caption = card.caption(row.count, formatPercent(row.count, card.totalUses));
  const suffix = fitText(ctx, ` ${caption}`, CARD_WIDTH - 12 - countW, 11);
  const sx = x + (CARD_WIDTH - countW - textWidth(ctx, suffix, 11)) / 2;
  drawText(ctx, count, sx, y + 116, { size: 14, color: COLOR.ink, bold: true });
  drawText(ctx, suffix, sx + countW, y + 117, { size: 11, color: COLOR.muted });
  const track = CARD_WIDTH - 24;
  roundRect(ctx, x + 12, y + 127, track, 4, 2);
  ctx.fillStyle = COLOR.grid;
  ctx.fill();
  roundRect(ctx, x + 12, y + 127, Math.max((track * row.count) / card.max, 3), 4, 2);
  ctx.fillStyle = COLOR.current;
  ctx.fill();
};

const shownCards = (ranking: StickerRanking): StickerRanking['rows'] =>
  ranking.rows.slice(0, STICKER_RANK_LIMIT);

const gridWidth = (columns: number): number => columns * CARD_WIDTH + GAP * (columns - 1);

const gridHeight = (cards: number, columns: number): number => {
  const rows = Math.ceil(cards / columns);
  return rows === 0 ? 0 : rows * (CARD_HEIGHT + GAP) - GAP;
};

/** The cards a row that show the ranking largest in Discord's image box. */
const columnCount = (cards: number): number =>
  largestInEmbed(COLUMN_CHOICES, (columns) => ({
    widths: [SUMMARY_WIDTH, gridWidth(columns)],
    height: TITLE_HEIGHT + gridHeight(cards, columns) + NOTE_HEIGHT,
  })) ?? COLUMN_CHOICES[0];

const rankingBlocks = (measure: Ctx, ranking: StickerRanking, col: Column): Block[] => {
  const rows = shownCards(ranking);
  const columns = columnCount(rows.length);
  const gridH = gridHeight(rows.length, columns);
  const noteH = ranking.note === undefined ? 0 : NOTE_HEIGHT;
  const card: CardContext = {
    caption: ranking.countCaption,
    totalUses: ranking.totalUses,
    max: Math.max(1, ...rows.map((r) => r.count)),
  };
  return [
    sectionTitle(measure, col, ranking.title),
    {
      height: gridH + noteH,
      draw: (ctx, y) => {
        rows.forEach((row, i) => {
          const cx = col.x + (i % columns) * (CARD_WIDTH + GAP);
          const cy = y + Math.floor(i / columns) * (CARD_HEIGHT + GAP);
          drawCard(ctx, row, i + 1, card, cx, cy);
        });
        if (ranking.note === undefined) return;
        drawText(ctx, ranking.note, col.x, y + gridH + 15, { size: 12, color: COLOR.muted });
      },
    },
  ];
};

export const renderStickerDashboard = (data: StickerDashboard): Buffer =>
  renderColumns([
    {
      width: SUMMARY_WIDTH,
      sections: (col, measure) => [
        data.tiles.length > 0 ? tileRows(data.tiles, col) : undefined,
        data.unused === undefined
          ? undefined
          : unusedBlocks(measure, data.unused, col, UNUSED_ROWS, UNUSED_SIZE),
      ],
    },
    {
      width: gridWidth(columnCount(shownCards(data.ranking).length)),
      sections: (col, measure) => [rankingBlocks(measure, data.ranking, col)],
    },
  ]);
