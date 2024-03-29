/// <reference path="zulip-js.d.ts"/>

import type { ApiResponse, Dest, Msg, Narrow, ZulipClient } from 'zulip-js';
import zulip from 'zulip-js';
import { MsgHandler } from './handler.js';
import { sleep } from './utils.js';

export class Zulip {
  private constructor(public client: ZulipClient) {}
  static new = async (zuliprc: string) => new Zulip(await zulip({ zuliprc }));

  send = async (dest: Dest, text: string) =>
    await this.client.messages.send({
      ...dest,
      content: text,
    });
  sendToUser = async (id: number, text: string) => await this.send({ type: 'private', to: [id] }, text);
  reply = async (to: Msg, text: string) => await this.send(msgToDest(to), text);
  react = async (to: Msg | number, emoji: string) =>
    await this.client.reactions.add({
      message_id: typeof to === 'number' ? to : to.id,
      emoji_name: emoji,
    });
  unreact = async (to: Msg | number, emoji: string) =>
    await this.client.reactions.remove({
      message_id: typeof to === 'number' ? to : to.id,
      emoji_name: emoji,
    });
  botName = async () => {
    const me = await assertSuccess(this.client.users.me.getProfile());
    return me.full_name;
  };
  sendA = wrapAssert(this.send);
  replyA = wrapAssert(this.reply);
  reactA = wrapAssert(this.react);

  eventLoop = async (narrow: Narrow[], msgHandler: MsgHandler) => {
    const q = await assertSuccess(
      this.client.queues.register({
        event_types: ['message'],
        narrow,
      })
    );

    const me = await assertSuccess(this.client.users.me.getProfile());
    console.log(`Connected to zulip as @${me.full_name}`);
    // await this.sendA({ type: 'stream', to: 'zulip', topic: 'bots log' }, 'I started.');

    let lastEventId = q.last_event_id;

    while (true) {
      try {
        const timeout = setTimeout(() => {
          console.log('events.retrieve timed out. Exiting...');
          process.exit();
        }, (q.event_queue_longpoll_timeout_seconds ?? 90) * 1_000);

        const res = await this.client.events.retrieve({
          queue_id: q.queue_id,
          last_event_id: lastEventId,
        });

        clearTimeout(timeout);

        if (res.result !== 'success') {
          console.error(`Got error response on events.retrieve: ${JSON.stringify(res)}`);
          if (res.code === 'BAD_EVENT_QUEUE_ID') return;
          await sleep(2000);
          continue;
        }

        for (const event of res.events) {
          lastEventId = event.id;
          switch (event.type) {
            case 'heartbeat':
              // console.log('Zulip heartbeat');
              break;
            case 'message':
              if (
                event.message.sender_id !== me.user_id &&
                (event.message.content.startsWith(`@**${me.full_name}**`) || event.message.content.startsWith('@cr '))
              )
                await msgHandler.handle(event.message);
              break;
            default:
              console.log(event);
              break;
          }
        }
      } catch (e) {
        console.error(e);
        await sleep(2000);
      }
    }
  };
}

const msgToDest = (orig: Msg): Dest => {
  return orig.type == 'stream'
    ? {
        type: 'stream',
        to: orig.stream_id,
        topic: orig.subject,
      }
    : {
        type: 'private',
        to: [orig.sender_id],
      };
};

const wrapAssert =
  <T, A extends any[]>(f: (...args: A) => ApiResponse<T>): ((...args: A) => Promise<T>) =>
  async (...args) =>
    await assertSuccess(f(...args));

export const assertSuccess = async <T>(response: ApiResponse<T>): Promise<T> => {
  const resp = await response;
  if (resp.result !== 'success') throw new Error(`Got error response: ${JSON.stringify(resp)}`);
  return resp;
};
