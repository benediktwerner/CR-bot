import { exec as nodeExec } from 'child_process';
import * as fs from 'fs';
import type { Response } from 'node-fetch';
import { dirname } from 'path';
import { pipeline } from 'stream';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = dirname(__filename);

export const sleep = promisify(setTimeout);

export const exec = promisify(nodeExec);

export const parseTime = (s: string): number | undefined => {
  let match;
  if ((match = s.match(/^(\d+)$/))) return parseInt(match[1], 10);
  else if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return Date.parse(match[1]);
  else if ((match = s.match(/^(\d+)d(ays?)?$/)))
    return +new Date() - parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
};

export const formatTimestamp = (t: number): string => new Date(t).toISOString().split('T')[0];

const streamPipeline = promisify(pipeline);

export const pipeToFile = async (
  res: Response,
  _abortCtrl: AbortController,
  fname: string
): Promise<void> => {
  await streamPipeline(res.body, fs.createWriteStream(fname));
};

export const pipeNjdsonToFile =
  (filterMap: (o: any) => undefined | string, max?: number) =>
  async (res: Response, abortCtrl: AbortController, fname: string): Promise<void> => {
    const fileStream = fs.createWriteStream(fname);
    try {
      const matcher = /\r?\n/;
      let buf = '';
      let count = 0;
      for await (const chunk of res.body) {
        buf += chunk.toString();
        const parts = buf.split(matcher);
        buf = parts.pop();
        parts
          .filter(Boolean)
          .map((line) => filterMap(JSON.parse(line)))
          .filter(Boolean)
          .forEach((pgn) => {
            count++;
            fileStream.write(pgn);
          });
        if (count >= max) {
          abortCtrl.abort();
          return;
        }
      }
      if (buf.length > 0) {
        const pgn = filterMap(JSON.parse(buf));
        if (pgn) fileStream.write(pgn);
      }
    } finally {
      fileStream.close();
    }
  };
