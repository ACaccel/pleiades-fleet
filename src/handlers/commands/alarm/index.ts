import AlarmSet from '../alarm_set/action';
import AlarmList from '../alarm_list/action';
import AlarmDelete from '../alarm_delete/action';
import { GroupedCommand } from '../grouped-command';

/** `/alarm`: one-shot messages posted in a channel at a chosen time. */
export default class alarm extends GroupedCommand {
  constructor() {
    super({
      name: 'alarm',
      category: 'community',
      guildOnly: true,
      routes: [
        { name: 'set', command: new AlarmSet() },
        { name: 'list', command: new AlarmList() },
        { name: 'delete', command: new AlarmDelete() },
      ],
    });
  }
}
