import { Msg } from 'zulip-js';
import { formatTimestamp, parseTime } from './utils.js';

export interface IdsCommand {
  type: 'ids';
  user: string;
  ids: string[];
}
export interface RecentCommand {
  type: 'recent';
  user: string;
  variant: string;
  count: number;
  with_casual?: boolean;
  before_epoch?: number;
  after_epoch?: number;
  max_advantage?: number;
}
export type Command =
  | { type: 'help' }
  | { type: 'invalid'; reason: string }
  | IdsCommand
  | RecentCommand;

export const parseCmd = (msg: Msg): Command => {
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