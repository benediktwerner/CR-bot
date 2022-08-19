import { Narrow } from 'zulip-js';
import { config } from './config.js';
import { MsgHandler } from './handler.js';
import { sleep } from './utils.js';
import { Zulip } from './zulip.js';

(async () => {
  const zuliprc = process.argv.includes('--test') ? 'zuliprc_test' : 'zuliprc';
  const zulip = await Zulip.new(zuliprc);

  const narrow: Narrow[] = [['stream', config.zulip.stream]];

  const handler = new MsgHandler(zulip);
  while (true) {
    await zulip.eventLoop(narrow, handler);
    await sleep(10_000);
  }
})();
