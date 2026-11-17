/**
 * Custom-emoji dashboard in two columns: the summary tiles above
 * the pictures of emoji nobody used, beside the ranking flowing down two
 * to five lanes (art, name, animated chip, total, and a content / reaction
 * split bar). The lane count is the one Discord shows largest in its 4:3
 * image box, so a long ranking grows wider instead of into a tall strip.
 */
import { largestInEmbed, renderColumns } from './columns';
import { EMOJI_ROW_HEIGHT, drawCell } from './emoji-cell';
import { TITLE_HEIGHT, sectionTitle, type Block, type Column, type Ctx } from './layout';
import { hline, swatchLegend } from './shapes';
import { drawText } from './text';
import { COLOR, COLUMN_GAP } from './theme';
import { tileRows } from './tiles';
import { unusedBlocks } from './unused';
import type { EmojiDashboard, EmojiRanking } from './types';

/** Rows drawn when the member does not choose: two lanes of ten. */
export const EMOJI_DEFAULT_ROWS = 20;
/** The most rows a ranking draws: five lanes of twenty. */
export const EMOJI_RANK_LIMIT = 100;

const NOTE_HEIGHT = 22;
/**
 * Halves as narrow as a cell allows: the image is wider than 4:3, so Discord
 * fits it by width and every pixel of width saved enlarges the text.
 */
const SUMMARY_WIDTH = 200;
const LANE_WIDTH = 230;
/** Lane counts to choose from; five lanes hold a full ranking at twenty rows each. */
const LANE_CHOICES = [2, 3, 4, 5] as const;
/** Picture rows that keep the summary column no taller than a default ranking. */
const UNUSED_ROWS = 7;
const UNUSED_SIZE = 26;

const shownRows = (ranking: EmojiRanking): EmojiRanking['rows'] =>
  ranking.rows.slice(0, EMOJI_RANK_LIMIT);

const rankingWidth = (lanes: number): number => lanes * LANE_WIDTH + (lanes - 1) * COLUMN_GAP;

const rowsPerLane = (rows: number, lanes: number): number => Math.max(1, Math.ceil(rows / lanes));

/** The lane count that shows the ranking largest in Discord's image box. */
const laneCount = (rows: number): number =>
  largestInEmbed(LANE_CHOICES, (lanes) => ({
    widths: [SUMMARY_WIDTH, rankingWidth(lanes)],
    height: TITLE_HEIGHT + 4 + rowsPerLane(rows, lanes) * EMOJI_ROW_HEIGHT + NOTE_HEIGHT,
  })) ?? LANE_CHOICES[0];

const lanesOf = (col: Column, lanes: number): Column[] =>
  Array.from({ length: lanes }, (_, i) => ({
    x: col.x + i * (LANE_WIDTH + COLUMN_GAP),
    w: LANE_WIDTH,
  }));

const rankingBlocks = (measure: Ctx, ranking: EmojiRanking, col: Column): Block[] => {
  const rows = shownRows(ranking);
  const lanes = lanesOf(col, laneCount(rows.length));
  // The shown rows split evenly, ranks 1..n down the leftmost lane first.
  const perLane = rowsPerLane(rows.length, lanes.length);
  const noteH = ranking.note === undefined ? 0 : NOTE_HEIGHT;
  const legend = swatchLegend([ranking.contentLabel, ranking.reactionLabel]);
  return [
    sectionTitle(measure, col, ranking.title, { legend, legendSize: 12 }),
    {
      height: 4 + perLane * EMOJI_ROW_HEIGHT + noteH,
      draw: (ctx, y) => {
        const top = y + 4;
        rows.forEach((row, i) => {
          const lane = lanes[Math.floor(i / perLane)] ?? col;
          const cy = top + (i % perLane) * EMOJI_ROW_HEIGHT;
          drawCell(ctx, row, i + 1, ranking.animatedTag, lane, cy);
        });
        lanes.forEach((lane, l) => {
          const inLane = Math.min(perLane, rows.length - l * perLane);
          for (let r = 1; r < inLane; r++) {
            hline(ctx, lane.x, lane.x + lane.w, top + r * EMOJI_ROW_HEIGHT, COLOR.grid);
          }
        });
        if (ranking.note === undefined) return;
        const noteY = top + perLane * EMOJI_ROW_HEIGHT + 15;
        drawText(ctx, ranking.note, col.x, noteY, { size: 12, color: COLOR.muted });
      },
    },
  ];
};

export const renderEmojiDashboard = (data: EmojiDashboard): Buffer =>
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
      width: rankingWidth(laneCount(shownRows(data.ranking).length)),
      sections: (col, measure) => [rankingBlocks(measure, data.ranking, col)],
    },
  ]);
