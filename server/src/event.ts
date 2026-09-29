import type { Env } from './env.js';

export type EventStatus = 'not_open' | 'open' | 'closed';

export function eventStatus(env: Env, now: Date): EventStatus {
  if (now < env.UPLOAD_OPENS_AT) return 'not_open';
  if (now > env.UPLOAD_CLOSES_AT) return 'closed';
  return 'open';
}

export function eventInfo(env: Env, now: Date) {
  return {
    name: env.EVENT_NAME,
    status: eventStatus(env, now),
    opensAt: env.UPLOAD_OPENS_AT.toISOString(),
    closesAt: env.UPLOAD_CLOSES_AT.toISOString(),
    limits: {
      perWindow: env.GUEST_MAX_PER_WINDOW,
      windowMinutes: env.GUEST_WINDOW_MINUTES,
      total: env.GUEST_MAX_TOTAL,
    },
  };
}
