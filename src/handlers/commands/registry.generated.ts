// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { Command } from '.';
import { default as Handler_0 } from './activity';
import { default as Handler_1 } from './ai';
import { default as Handler_2 } from './alarm';
import { default as Handler_3 } from './archive';
import { default as Handler_4 } from './ban_user';
import { default as Handler_5 } from './bug_report';
import { default as Handler_6 } from './change_avatar';
import { default as Handler_7 } from './db';
import { default as Handler_8 } from './feed';
import { default as Handler_9 } from './gay';
import { default as Handler_10 } from './give_score';
import { default as Handler_11 } from './giveaway';
import { default as Handler_12 } from './help';
import { default as Handler_13 } from './level_detail';
import { default as Handler_14 } from './menu_author_avatar';
import { default as Handler_15 } from './menu_get_avatar';
import { default as Handler_16 } from './menu_get_sticker';
import { default as Handler_17 } from './menu_give_score';
import { default as Handler_18 } from './random_restaurant';
import { default as Handler_19 } from './reply';
import { default as Handler_20 } from './role';
import { default as Handler_21 } from './roll_call';
import { default as Handler_22 } from './settings';
import { default as Handler_23 } from './talk';
import { default as Handler_24 } from './thread';
import { default as Handler_25 } from './traffic';
export const COMMAND_REGISTRY = {
  activity: Handler_0,
  ai: Handler_1,
  alarm: Handler_2,
  archive: Handler_3,
  ban_user: Handler_4,
  bug_report: Handler_5,
  change_avatar: Handler_6,
  db: Handler_7,
  feed: Handler_8,
  gay: Handler_9,
  give_score: Handler_10,
  giveaway: Handler_11,
  help: Handler_12,
  level_detail: Handler_13,
  menu_author_avatar: Handler_14,
  menu_get_avatar: Handler_15,
  menu_get_sticker: Handler_16,
  menu_give_score: Handler_17,
  random_restaurant: Handler_18,
  reply: Handler_19,
  role: Handler_20,
  roll_call: Handler_21,
  settings: Handler_22,
  talk: Handler_23,
  thread: Handler_24,
  traffic: Handler_25,
} as const satisfies Readonly<Record<string, new () => Command>>;
