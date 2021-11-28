import { Narrow } from 'zulip-js';
import { config } from './config.js';
import { MsgHandler } from './handler.js';
import { Zulip } from './zulip.js';

(async () => {
  const zulip = await Zulip.new();

  const narrow: Narrow[] = [['stream', config.zulip.stream]];

  await zulip.eventLoop(narrow, new MsgHandler(zulip));
})();
