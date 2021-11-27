import * as fs from 'fs';
import { readFile } from 'fs/promises';
import fetch, { RequestInit, Response, AbortError } from 'node-fetch';
import { Msg, Narrow } from 'zulip-js';
import { exec, formatTimestamp, parseTime, pipeNjdsonToFile, pipeToFile, sleep } from './utils.js';
import { Zulip } from './zulip.js';

type IdsCommand = { type: 'ids'; user: string; ids: string[] };
type RecentCommand = {
  type: 'recent';
  user: string;
  variant: string;
  count: number;
  with_casual?: boolean;
  before_epoch?: number;
  after_epoch?: number;
  max_advantage?: number;
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
    let match;
    for (const arg of args.map((a) => a.toLowerCase())) {
      if (arg === 'recent') {
      } else if (['bullet', 'blitz', 'rapid', 'classical'].includes(arg)) cmd.variant = arg;
      else if (arg === '+casual') cmd.with_casual = true;
      else if (/^\d+$/.test(arg)) cmd.count = parseInt(arg, 10);
      else if ((match = arg.match(/^advantage<(\d+)$/))) cmd.max_advantage = parseInt(match[1], 10);
      else if ((match = arg.match(/^time(<|>)(.+)$/))) {
        const [_, op, timeStr] = match;
        const time = parseTime(timeStr);
        if (!time || isNaN(time)) return invalid(`Invalid date/time format: ${timeStr}`);
        if (time > Date.parse('2100-01-01'))
          return invalid(`Date is too far in the future (${formatTimestamp(time)})`);
        if (time < Date.parse('2010-01-01'))
          return invalid(`Date is too far in the past (${formatTimestamp(time)})`);
        if (op === '<') cmd.before_epoch = time;
        else cmd.after_epoch = time;
      } else return invalid(`Invalid parameter: \`${arg}\``);
    }
    if (!('variant' in cmd)) return invalid('No variant specified');
    if (!('count' in cmd)) return invalid('No game count specified');
    if (cmd.count > 100) return invalid('Max count has to be <100');
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
    await zulip.reply(msg, `:cross_mark: ${reason}. Use \`@**cr** help\` for usage instructions.`);
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
        '- `@**cr** thibault recent 20 blitz time<1638009640`: Same but use 20 last games before the 1638009640 UNIX timestamp.\n' +
        '- `@**cr** thibault recent 20 blitz time<2021-11-03`: Same but use 20 last games before the 3rd November 2021.\n' +
        '- `@**cr** thibault recent 20 blitz time>2021-11-03`: Same but use up to 20 last games after the 3rd November 2021.\n' +
        '- `@**cr** thibault recent 20 blitz time>2d`: Same but use up to 20 last games during the last 2 days.\n' +
        '- `@**cr** thibault recent 20 blitz advantage<100`: Same but only include games where Thibault has no more than 100 rating over his opponent.\n' +
        '\nParameters for recent games can be passed in arbitrary order.'
    );
  };

  const doCR = async (
    msg: Msg,
    cmd: IdsCommand | RecentCommand,
    url: string,
    options: RequestInit,
    handleResponse: (res: Response, abortCtrl: AbortController, pgnPath: string) => Promise<void>
  ) => {
    let res: Response;
    const abortCtrl = new AbortController();
    for (let retried = false; !retried; retried = true) {
      res = await fetch(url, { ...options, signal: abortCtrl.signal });
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

    try {
      await handleResponse(res, abortCtrl, pgnPath);
    } catch (error) {
      if (!(error instanceof AbortError)) throw error;
    }

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
    await doCR(
      msg,
      cmd,
      'https://lichess.org/games/export/_ids',
      {
        method: 'post',
        body: cmd.ids.join(','),
      },
      pipeToFile
    );
  };

  const handelRecent = async (msg: Msg, cmd: RecentCommand): Promise<void> => {
    const params = new URLSearchParams();
    params.append('perfType', cmd.variant);
    if (cmd.max_advantage) params.append('max', (cmd.count * 5).toString());
    else params.append('max', cmd.count.toString());
    if (cmd.before_epoch) params.append('until', `${cmd.before_epoch}000`);
    if (cmd.after_epoch) params.append('since', `${cmd.after_epoch}000`);
    if (!cmd.with_casual) params.append('rated', 'true');

    if (cmd.max_advantage) {
      params.append('pgnInJson', 'true');
      await doCR(
        msg,
        cmd,
        `https://lichess.org/api/games/user/${cmd.user}?${params}`,
        {
          headers: {
            Accept: 'application/x-ndjson',
          },
        },
        pipeNjdsonToFile((o) => {
          const playerColor =
            o.players.white.user.id === cmd.user.toLowerCase() ? 'white' : 'black';
          const player = o.players[playerColor];
          const opponent = o.players[playerColor === 'white' ? 'black' : 'white'];
          if (opponent.provisional && cmd.max_advantage < 2000) return;
          if (player.rating - opponent.rating < cmd.max_advantage) return o.pgn;
        }, cmd.count)
      );
    } else
      await doCR(
        msg,
        cmd,
        `https://lichess.org/api/games/user/${cmd.user}?${params}`,
        {},
        pipeToFile
      );
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
