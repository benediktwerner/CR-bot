import * as fs from 'fs';
import * as path from 'path';
import { readFile } from 'fs/promises';
import fetch, { AbortError, RequestInit, Response } from 'node-fetch';
import { Msg } from 'zulip-js';
import { config } from './config.js';
import { IdsCommand, parseCmd, RecentCommand } from './parser.js';
import { exec, pipeNjdsonToFile, pipeToFile, sleep } from './utils.js';
import { Zulip } from './zulip.js';

export class MsgHandler {
  constructor(private z: Zulip) {
    fs.mkdirSync('pgn', { recursive: true });
    fs.mkdirSync('reports', { recursive: true });
  }

  handleInvalid = async (msg: Msg, reason: string): Promise<void> => {
    await this.z.reply(msg, `:cross_mark: ${reason}. Use \`@**cr** help\` for usage instructions.`);
  };

  handleHelp = async (msg: Msg): Promise<void> => {
    await this.z.reply(
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

  doCR = async (
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
          await this.z.reply(msg, ':time_ticking: Rate-limited. Waiting for 10 minutes.');
          await sleep(10 * 60);
        } else {
          await this.z.reply(msg, `:cross_mark: Error while fetching games: ${res.statusText}`);
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
    await exec(
      `${config.python_bin} ${path.join(
        __dirname,
        'ChessReanalysis',
        'main.py'
      )} ${pgnPath} ${reportPath}`
    );

    const report = await readFile(reportPath, { encoding: 'ascii' });
    const match = report.match(new RegExp(`(${cmd.user.toLowerCase()}.*?)\n\n`, 's'));
    if (match) {
      await this.z.reply(
        msg,
        `@**${msg.sender_full_name}** CR report on /${cmd.user} completed:\n\n\`\`\`\n${match[1]}\n\`\`\``
      );
      await this.z.react(msg, 'check');
    } else {
      console.log(`Failed to find report about ${cmd.user} in CR output:\n${report}`);
      await this.z.reply(msg, ':cross_mark: No CR output');
    }
  };

  handleIds = async (msg: Msg, cmd: IdsCommand): Promise<void> => {
    await this.doCR(
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

  handelRecent = async (msg: Msg, cmd: RecentCommand): Promise<void> => {
    const params = new URLSearchParams();
    params.append('perfType', cmd.variant);
    if (cmd.max_advantage) params.append('max', (cmd.count * 5).toString());
    else params.append('max', cmd.count.toString());
    if (cmd.before_epoch) params.append('until', `${cmd.before_epoch}000`);
    if (cmd.after_epoch) params.append('since', `${cmd.after_epoch}000`);
    if (!cmd.with_casual) params.append('rated', 'true');

    if (cmd.max_advantage) {
      params.append('pgnInJson', 'true');
      await this.doCR(
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
      await this.doCR(
        msg,
        cmd,
        `https://lichess.org/api/games/user/${cmd.user}?${params}`,
        {},
        pipeToFile
      );
  };

  public handle = async (msg: Msg): Promise<void> => {
    await this.z.react(msg, 'time_ticking');

    try {
      const cmd = parseCmd(msg);
      if (cmd.type === 'invalid') await this.handleInvalid(msg, cmd.reason);
      else if (cmd.type === 'help') await this.handleHelp(msg);
      else if (cmd.type === 'ids') await this.handleIds(msg, cmd);
      else if (cmd.type === 'recent') await this.handelRecent(msg, cmd);
      else await this.handleInvalid(msg, `Unexpected parsed command: ${cmd}`);
    } catch (err) {
      console.error(err);
      await this.z.react(msg, 'cross_mark');
    } finally {
      await this.z.unreact(msg, 'time_ticking');
    }
  };
}
