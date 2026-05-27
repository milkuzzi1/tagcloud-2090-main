import type { ServerMsg } from '$lib/types/cloud';

export type { ServerMsg, ClientMsg } from '$lib/types/cloud';

export function encode(msg: ServerMsg): string {
  return JSON.stringify(msg);
}
