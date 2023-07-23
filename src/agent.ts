// https://github.com/node-fetch/node-fetch/issues/1297
// Tries to connect to IPv6 and IPv4 addresses in parallel, preferring IPv6.

import { createConnection } from 'happy-eyeballs';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

export class HappyEyeballsHttpAgent extends HttpAgent {
  createConnection = createConnection;
}

export class HappyEyeballsHttpsAgent extends HttpsAgent {
  createConnection = createConnection;
}

export const happyEyeballsHttpAgent = new HappyEyeballsHttpAgent();
export const happyEyeballsHttpsAgent = new HappyEyeballsHttpsAgent();
