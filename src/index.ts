import fetch from 'node-fetch';
import { Msg, Narrow } from 'zulip-js';
import { Zulip } from './zulip.js';
import * as fs from 'fs';
import { readFile } from 'fs/promises';
import { exec } from './utils.js';

(async () => {
  fs.mkdirSync('pgn', { recursive: true });
  fs.mkdirSync('reports', { recursive: true });

  const zulip = await Zulip.new();

  const narrow: Narrow[] = [
    ['stream', process.env.CR_BOT_STREAM],
    ['topic', process.env.CR_BOT_TOPIC],
  ];

  const validate = (user: undefined | string, gameIds: string[]): undefined | string => {
    if (!user) return 'Missing username';

    if (!/^[a-zA-Z0-9_-]+$/.test(user)) return 'Bad username';

    for (const id of gameIds) {
      if (!/^[a-zA-Z0-9]{8}$/.test(id)) return 'Bad game ID: `' + id + '`';
    }

    if (gameIds.length < 1 || gameIds.length > 100)
      return 'Too few or many game IDs. Provide between 1 and 100 game IDs.';
  };

  const msgHandler = async (msg: Msg): Promise<void> => {
    try {
      const [user, ...args] = msg.content
        .replace(/@\*\*.+?\*\*/, '')
        .trim()
        .split(/\s+/);

      await zulip.react(msg, 'time_ticking');
      const gameIds = args.map((id) =>
        id
          .replace(/(?:https?:\/\/)?lichess\.org\//, '')
          .replace('/black', '')
          .trim()
          .substr(0, 8)
      );

      const error = validate(user, gameIds);
      if (error) {
        await zulip.reply(msg, ':cross_mark: ' + error);
        return;
      }

      const res = await fetch('https://lichess.org/games/export/_ids', {
        method: 'post',
        body: gameIds.join(','),
      });

      // TODO: handle 429

      const date = new Date().toISOString().replace('T', '--').replace(/:|\./g, '-').replace('Z', '');
      const reportName = `${date}--${user}`;
      const pgnPath = `pgn/${reportName}.pgn`;
      const fileStream = fs.createWriteStream(pgnPath);
      await new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on('error', reject);
        fileStream.on('finish', resolve);
      });

      const reportPath = `reports/${reportName}.txt`;
      await exec(`${process.env.CR_CMD} ${pgnPath} ${reportPath}`);

      const report = await readFile(reportPath, { encoding: 'ascii' });
      const match = report.match(new RegExp(`(${user.toLowerCase()}.*?)\n\n`, 's'));
      if (match) {
        await zulip.reply(
          msg,
          `@**${msg.sender_full_name}** CR report on /${user} completed:\n\n\`\`\`\n${match[1]}\n\`\`\``
        );
        await zulip.react(msg, 'check');
      } else {
        console.log(`Failed to find report about ${user} in CR output:\n${report}`);
        await zulip.reply(msg, ':cross_mark: No CR output');
        await zulip.react(msg, 'cross_mark');
      }

      await zulip.unreact(msg, 'time_ticking');
    } catch (err) {
      console.error(err);
      await zulip.react(msg, 'cross_mark');
      await zulip.unreact(msg, 'time_ticking');
    }
  };

  await zulip.eventLoop(narrow, msgHandler);
})();
