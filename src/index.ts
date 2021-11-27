import * as fs from 'fs';
import { readFile } from 'fs/promises';
import fetch, { RequestInit, Response } from 'node-fetch';
import { Msg, Narrow } from 'zulip-js';
import { exec, sleep } from './utils.js';
import { Zulip } from './zulip.js';

type IdsCommand = { type: 'ids'; user: string; ids: string[] };
type RecentCommand = {
  type: 'recent';
  user: string;
  variant: string;
  count: number;
  with_casual?: boolean;
  before_epoch?: number;
};
type Command = { type: 'help' } | { type: 'invalid'; reason: string } | IdsCommand | RecentCommand;

const parseCmd = (msg: Msg): Command => {
  const parts = msg.content
    .replace(/@\*\*.+?\*\*/, '')
    .trim()
    .split(/\s+/)
    .map((p) => p.trim());

  if (parts.length === 0 || parts[0] === 'help') return { type: 'help' };

  const [user, ...args] = parts;

  const invalid = (reason: string): Command => {
    return { type: 'invalid', reason };
  };

  if (!user) return invalid('Missing username.');
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) return invalid('Bad username');
  if (args.length === 0) return invalid('Missing parameters');

  if (args.some((a) => a.toLowerCase() === 'recent')) {
    let cmd = { type: 'recent', user } as Partial<RecentCommand>;
    for (const arg of args.map((a) => a.toLowerCase())) {
      if (arg === 'recent') {
      } else if (['bullet', 'blitz', 'rapid', 'classical'].includes(arg)) cmd.variant = arg;
      else if (arg === '+casual') cmd.with_casual = true;
      else if (/^\d+$/.test(arg)) cmd.count = parseInt(arg, 10);
      else {
        const match = /^before=(\d+)$/.exec(arg);
        if (match) cmd.before_epoch = parseInt(match[1], 10);
        else return invalid(`Invalid parameter: ${arg}`);
      }
    }
    if (!('variant' in cmd)) return invalid('No variant specified');
    if (!('count' in cmd)) return invalid('No game count specified');
    return cmd as RecentCommand;
  } else {
    const gameIds = args.map((id) =>
      id
        .replace(/(?:https?:\/\/)?lichess\.org\//, '')
        .replace('/black', '')
        .trim()
        .substr(0, 8)
    );

    for (const id of gameIds) {
      if (!/^[a-zA-Z0-9]{8}$/.test(id)) return invalid('Bad game ID: `' + id + '`');
    }

    if (gameIds.length < 1 || gameIds.length > 100)
      return invalid('Too few or many game IDs. Provide between 1 and 100 game IDs.');

    return { type: 'ids', user, ids: gameIds };
  }
};

(async () => {
  fs.mkdirSync('pgn', { recursive: true });
  fs.mkdirSync('reports', { recursive: true });

  const zulip = await Zulip.new();

  const handleInvalid = async (msg: Msg, reason: string): Promise<void> => {
    await zulip.reply(msg, `:cross_mark: ${reason} Use \`@**cr** help\` for usage instructions.`);
  };

  const handleHelp = async (msg: Msg): Promise<void> => {
    await zulip.reply(
      msg,
      'Usage:\n' +
        '- `@**cr** help`: Show this help.\n' +
        '- `@**cr** thibault abcdefgh ijklmnop`: Run CR report on Thibault with game IDs abcdefgh and ijklmnop. You can add up to 100 game IDs.\n' +
        '- `@**cr** thibault https://lichess.org/abcdefgh`: Run CR report on Thibault with the linked game.\n' +
        "- `@**cr** thibault recent 20 blitz`: Run CR report on Thibault's last 20 blitz games. Supported speeds are `bullet`, `blitz`, `rapid`, and `classical`.\n" +
        '- `@**cr** thibault recent 20 blitz +casual`: Same but include casual games.\n' +
        '- `@**cr** thibault recent 20 blitz before=1638009640`: Same but use 20 last games before the 1638009640 UNIX timestamp.\n' +
        '\nParameters for recent games can be passed in arbitrary order.'
    );
  };

  const doCR = async (
    msg: Msg,
    cmd: IdsCommand | RecentCommand,
    url: string,
    options?: RequestInit
  ) => {
    let res: Response;
    for (let retried = false; !retried; retried = true) {
      res = await fetch(url, options);
      if (!res.ok) {
        if (res.status === 429 && !retried) {
          await zulip.reply(msg, ':time_ticking: Rate-limited. Waiting for 10 minutes.');
          await sleep(10 * 60);
        } else {
          await zulip.reply(msg, `:cross_mark: Error while fetching games: ${res.statusText}`);
          return;
        }
      }
    }

    const date = new Date().toISOString().replace('T', '--').replace(/:|\./g, '-').replace('Z', '');
    const reportName = `${date}--${cmd.user}`;
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
    const match = report.match(new RegExp(`(${cmd.user.toLowerCase()}.*?)\n\n`, 's'));
    if (match) {
      await zulip.reply(
        msg,
        `@**${msg.sender_full_name}** CR report on /${cmd.user} completed:\n\n\`\`\`\n${match[1]}\n\`\`\``
      );
      await zulip.react(msg, 'check');
    } else {
      console.log(`Failed to find report about ${cmd.user} in CR output:\n${report}`);
      await zulip.reply(msg, ':cross_mark: No CR output');
    }
  };

  const handleIds = async (msg: Msg, cmd: IdsCommand): Promise<void> => {
    await doCR(msg, cmd, 'https://lichess.org/games/export/_ids', {
      method: 'post',
      body: cmd.ids.join(','),
    });
  };

  const handelRecent = async (msg: Msg, cmd: RecentCommand): Promise<void> => {
    const params = new URLSearchParams();
    params.append('perfType', cmd.variant);
    params.append('max', cmd.count.toString());
    if (cmd.before_epoch) params.append('until', `${cmd.before_epoch}000`);
    if (!cmd.with_casual) params.append('rated', 'true');

    await doCR(msg, cmd, `https://lichess.org/api/games/user/${cmd.user}?${params}`);
  };

  const msgHandler = async (msg: Msg): Promise<void> => {
    await zulip.react(msg, 'time_ticking');

    try {
      const cmd = parseCmd(msg);
      if (cmd.type === 'invalid') await handleInvalid(msg, cmd.reason);
      else if (cmd.type === 'help') await handleHelp(msg);
      else if (cmd.type === 'ids') await handleIds(msg, cmd);
      else if (cmd.type === 'recent') await handelRecent(msg, cmd);
      else await handleInvalid(msg, `Unexpected parsed command: ${cmd}`);
    } catch (err) {
      console.error(err);
      await zulip.react(msg, 'cross_mark');
    } finally {
      await zulip.unreact(msg, 'time_ticking');
    }
  };

  const narrow: Narrow[] = [['stream', process.env.CR_ZULIP_STREAM]];

  await zulip.eventLoop(narrow, msgHandler);
})();
