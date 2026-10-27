/**
 * `BaseBot` -> {@link AlarmDeps} bridge for the interaction path. The
 * plugin builds the same bundle from its context; keeping the bridge in
 * its own file keeps the `BaseBot` dependency out of the shared service.
 */
import type { BaseBot } from '@bot';

import type { AlarmDeps } from '../../../application/alarm/alarm';

export const buildAlarmDepsFromBot = (bot: BaseBot): AlarmDeps => ({
  client: bot.client,
  registry: bot.guildRegistry,
  jobMap: bot.jobMap,
  logger: bot.requireLogger(),
  translator: bot.translator,
});
