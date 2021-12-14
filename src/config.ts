import { readFileSync } from 'fs';

interface Config {
  zulip: {
    stream: string;
  };
  python_bin: string;
}

export const config: Config = JSON.parse(
  readFileSync('config.base.json', 'utf-8')
);
try {
  Object.assign(config, JSON.parse(readFileSync('config.json', 'utf-8')));
} catch {}
