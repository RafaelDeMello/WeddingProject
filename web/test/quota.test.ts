import { describe, expect, it } from 'vitest';
import { quotaView } from '../src/quota';

const now = Date.parse('2026-10-03T22:00:00Z');
const q = (remainingInWindow: number, remainingTotal: number, resetsAt: string | null = null) => ({
  remainingInWindow,
  remainingTotal,
  resetsAt,
});

describe('quotaView', () => {
  it('janela limitando: "N fotos disponíveis agora"', () => {
    expect(quotaView(q(10, 150), 0, now)).toMatchObject({ available: 10, suffix: 'fotos disponíveis agora', limitMessage: null });
    expect(quotaView(q(1, 150), 0, now)).toMatchObject({ available: 1, suffix: 'foto disponível agora' });
  });

  it('total limitando: "N fotos restantes"', () => {
    expect(quotaView(q(4, 4), 0, now)).toMatchObject({ available: 4, suffix: 'fotos restantes' });
    expect(quotaView(q(1, 1), 0, now)).toMatchObject({ available: 1, suffix: 'foto restante' });
  });

  it('desconta as fotos na fila', () => {
    expect(quotaView(q(10, 150), 3, now).available).toBe(7);
  });

  it('janela esgotada: "tente novamente em X min" a partir de resetsAt', () => {
    const view = quotaView(q(0, 140, new Date(now + 6.5 * 60_000).toISOString()), 0, now);
    expect(view.available).toBe(0);
    expect(view.limitMessage).toBe('Você atingiu o limite, tente novamente em 7 min.');
  });

  it('total esgotado: "já enviou o máximo", nunca minutos', () => {
    const view = quotaView(q(0, 0, new Date(now + 60_000).toISOString()), 0, now);
    expect(view.limitMessage).toBe('Você já enviou o máximo de fotos.');
  });

  it('total esgotado contando a fila também vira "máximo"', () => {
    expect(quotaView(q(2, 2), 2, now).limitMessage).toBe('Você já enviou o máximo de fotos.');
  });
});
