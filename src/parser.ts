import { Msg } from 'zulip-js';
import { determinePerfType, formatTimestamp, parseTime } from './utils.js';

export interface IdsCommand {
  type: 'ids';
  user: string;
  ids: string[];
}
export interface RecentCommand {
  type: 'recent';
  user: string;
  perfType: string;
  time_control: { minutes: number; inc: number };
  count: number;
  with_casual?: boolean;
  before_epoch?: number;
  after_epoch?: number;
  max_advantage?: number;
  min_moves?: number;
  max_moves?: number;
}
export interface TournamentCommand {
  type: 'tournament';
  tournament_type: 'swiss' | 'tournament';
  id: string;
  user: string;
  max_advantage?: number;
  min_moves?: number;
  max_moves?: number;
}
export type ValidCommand = IdsCommand | RecentCommand | TournamentCommand;
export type Command =
  | { type: 'help' }
  | { type: 'invalid'; reason: string }
  | { type: 'status' }
  | { type: 'abort'; indexOrAll: number | 'all' }
  | ValidCommand;

export const parseCmd = (msg: Msg): Command => {
  const parts = msg.content
    .replace(/@\*\*.+?\*\*/, '')
    .replace(/^@cr/, '')
    .trim()
    .split(/\s+/)
    .map((p) => p.trim());

  if (parts.length === 0 || parts[0] === 'help') return { type: 'help' };
  if (parts[0] === 'status') return { type: 'status' };
  if (parts[0] === 'abort') {
    if (parts[1] === 'all') return { type: 'abort', indexOrAll: 'all' };
    try {
      return { type: 'abort', indexOrAll: parseInt(parts[1], 10) };
    } catch {
      return { type: 'invalid', reason: 'Invalid index' };
    }
  }

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
      } else if (['bullet', 'blitz', 'rapid', 'classical', 'chess960'].includes(arg)) {
        if (cmd.perfType === undefined) cmd.perfType = arg;
        else if (cmd.perfType !== arg) return invalid(`Duplicate perf types \`${cmd.perfType}\` and \`${arg}\``);
      } else if (arg === '+casual') cmd.with_casual = true;
      else if (/^\d+$/.test(arg)) cmd.count = parseInt(arg, 10);
      else if ((match = arg.match(/^(\d+)\+(\d+)$/))) {
        const [_, mins, inc] = match;
        try {
          cmd.time_control = {
            minutes: parseInt(mins, 10),
            inc: parseInt(inc, 10),
          };
        } catch (e) {
          return invalid(`Failed to parse time control: ${arg}`);
        }
      } else if ((match = arg.match(/^advantage<(\d+)$/))) cmd.max_advantage = parseInt(match[1], 10);
      else if ((match = arg.match(/^moves(<|>)(\d+)$/))) {
        const [_, op, num] = match;
        if (op === '<') cmd.max_moves = parseInt(num, 10);
        else cmd.min_moves = parseInt(num, 10);
      } else if ((match = arg.match(/^time(<|>)(.+)$/))) {
        const [_, op, timeStr] = match;
        const time = parseTime(timeStr);
        if (!time || isNaN(time)) return invalid(`Invalid date/time format: ${timeStr}`);
        if (time > Date.parse('2100-01-01')) return invalid(`Date is too far in the future (${formatTimestamp(time)})`);
        if (time < Date.parse('2010-01-01')) return invalid(`Date is too far in the past (${formatTimestamp(time)})`);
        if (op === '<') cmd.before_epoch = time;
        else cmd.after_epoch = time;
      } else return invalid(`Invalid parameter: \`${arg}\``);
    }
    if (cmd.perfType === undefined) {
      if (!cmd.time_control) return invalid('No perf type specified');

      cmd.perfType = determinePerfType(cmd.time_control.minutes, cmd.time_control.inc);
    }
    if (cmd.count === undefined) return invalid('No game count specified');
    if (cmd.count > 100) return invalid('Max count has to be <100');
    return cmd as RecentCommand;
  } else if (args.some((a) => a.toLowerCase() === 'tournament' || a.toLowerCase() === 'swiss')) {
    let cmd = { type: 'tournament', user } as Partial<TournamentCommand>;
    let match;
    for (const arg of args) {
      const argLower = arg.toLowerCase();
      if (argLower === 'tournament' || argLower === 'swiss') {
      } else if ((match = arg.match(/^https:\/\/lichess.org\/(tournament|swiss)\/([a-zA-Z0-9]{8})$/))) {
        const [_, typ, id] = match;
        cmd.id = id;
        cmd.tournament_type = typ as any;
      } else if ((match = argLower.match(/^advantage<(\d+)$/))) cmd.max_advantage = parseInt(match[1], 10);
      else if ((match = argLower.match(/^moves(<|>)(\d+)$/))) {
        const [_, op, num] = match;
        if (op === '<') cmd.max_moves = parseInt(num, 10);
        else cmd.min_moves = parseInt(num, 10);
      } else return invalid(`Invalid parameter: \`${arg}\``);
    }
    if (!('id' in cmd)) return invalid('Missing tournament URL');
    return cmd as TournamentCommand;
  } else {
    const gameIds = args.map((id) =>
      id
        .replace(/(?:https?:\/\/)?lichess\.org\//, '')
        .replace('/black', '')
        .trim()
        .substring(0, 8)
    );

    for (const id of gameIds) {
      if (!/^[a-zA-Z0-9]{8}$/.test(id)) return invalid('Bad game ID: `' + id + '`');
    }

    if (gameIds.length < 1 || gameIds.length > 100)
      return invalid('Too few or many game IDs. Provide between 1 and 100 game IDs.');

    return { type: 'ids', user, ids: gameIds };
  }
};

export const formatCmd = (cmd: ValidCommand): string => {
  if (cmd.type === 'ids') {
    return `/${cmd.user} ids ${cmd.ids.join(' ')}`;
  }
  if (cmd.type === 'recent') {
    let s = `/${cmd.user} recent ${cmd.count} ${cmd.perfType}`;
    if (cmd.with_casual) s += '+casual';
    if (cmd.after_epoch) s += ` time>${cmd.after_epoch}`;
    if (cmd.before_epoch) s += ` time<${cmd.before_epoch}`;
    if (cmd.max_advantage) s += ` advantage<${cmd.max_advantage}`;
    if (cmd.max_moves) s += ` moves<${cmd.max_moves}`;
    if (cmd.min_moves) s += ` moves>${cmd.min_moves}`;
    return s;
  }
  if (cmd.type === 'tournament') {
    let s = `/${cmd.user} tournament ${cmd.tournament_type} ${cmd.id}`;
    if (cmd.max_advantage) s += ` advantage<${cmd.max_advantage}`;
    if (cmd.max_moves) s += ` moves<${cmd.max_moves}`;
    if (cmd.min_moves) s += ` moves>${cmd.min_moves}`;
    return s;
  }
  return 'Unexpected command';
};
