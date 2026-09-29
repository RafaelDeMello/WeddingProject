import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { getQuota } from '../src/quota.js';
import { createTestContext } from './helpers.js';

const WINDOW = {
  UPLOAD_OPENS_AT: '2026-10-03T00:00:00-03:00',
  UPLOAD_CLOSES_AT: '2026-10-06T23:59:59-03:00',
};

let ctx: Awaited<ReturnType<typeof createTestContext>> | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe('GET /api/event', () => {
  it.each([
    ['not_open', '2026-10-02T23:59:59-03:00'],
    ['open', '2026-10-03T00:00:00-03:00'],
    ['open', '2026-10-06T23:59:59-03:00'],
    ['closed', '2026-10-07T00:00:00-03:00'],
  ])('status %s em %s', async (status, at) => {
    ctx = await createTestContext(WINDOW, { now: () => new Date(at) });
    const res = await request(ctx.app).get('/api/event');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'Casamento de Teste',
      status,
      opensAt: '2026-10-03T03:00:00.000Z',
      closesAt: '2026-10-07T02:59:59.000Z',
      limits: { perWindow: 10, windowMinutes: 10, total: 150 },
    });
  });
});

describe('getQuota', () => {
  const now = new Date('2026-10-04T20:00:00-03:00');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  async function guestWithPhotos(times: Date[], overrides: Record<string, string> = {}) {
    ctx = await createTestContext(overrides);
    const guest = await ctx.prisma.guest.create({ data: { name: 'Ana' } });
    for (const [i, createdAt] of times.entries()) {
      await ctx.prisma.photo.create({
        data: {
          guestId: guest.id,
          clientUploadId: `c${i}`,
          filePath: 'p',
          thumbPath: 't',
          sizeBytes: 1,
          width: 1,
          height: 1,
          createdAt,
          hiddenAt: i === 0 ? now : null,
        },
      });
    }
    return guest.id;
  }

  it('conta só a janela deslizante; resetsAt = foto mais antiga da janela + janela; ocultas contam', async () => {
    const guestId = await guestWithPhotos([minutesAgo(3), minutesAgo(8), minutesAgo(11), minutesAgo(60)]);
    const quota = await getQuota(ctx!.prisma, ctx!.env, guestId, now);
    expect(quota).toEqual({
      remainingInWindow: 8,
      remainingTotal: 146,
      resetsAt: new Date(minutesAgo(8).getTime() + 10 * 60_000).toISOString(),
    });
  });

  it('janela limitada pelo que resta no total', async () => {
    const guestId = await guestWithPhotos([minutesAgo(30), minutesAgo(40), minutesAgo(50)], { GUEST_MAX_TOTAL: '4' });
    const quota = await getQuota(ctx!.prisma, ctx!.env, guestId, now);
    expect(quota).toEqual({ remainingInWindow: 1, remainingTotal: 1, resetsAt: null });
  });

  it('nunca negativo', async () => {
    const guestId = await guestWithPhotos([minutesAgo(1), minutesAgo(2), minutesAgo(3)], {
      GUEST_MAX_PER_WINDOW: '2',
      GUEST_MAX_TOTAL: '2',
    });
    const quota = await getQuota(ctx!.prisma, ctx!.env, guestId, now);
    expect(quota.remainingInWindow).toBe(0);
    expect(quota.remainingTotal).toBe(0);
  });
});
