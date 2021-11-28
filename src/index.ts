import { Narrow } from 'zulip-js';
import { MsgHandler } from './handler.js';
import { Zulip } from './zulip.js';

(async () => {
  const zulip = await Zulip.new();

  const narrow: Narrow[] = [['stream', process.env.CR_ZULIP_STREAM]];

  await zulip.eventLoop(narrow, new MsgHandler(zulip));
})();
