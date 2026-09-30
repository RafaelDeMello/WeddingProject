import { describe, expect, it } from 'vitest';
import { uuidFromBytes, uuidv4 } from '../src/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Simula o iOS < 15.4: só getRandomValues.
const semRandomUUID = { getRandomValues: (a: Uint8Array) => crypto.getRandomValues(a) };

describe('uuidv4', () => {
  it('usa randomUUID quando existe', () => {
    expect(uuidv4({ ...semRandomUUID, randomUUID: () => 'nativo' })).toBe('nativo');
  });

  it('sem randomUUID, gera UUID v4 válido com getRandomValues', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = uuidv4(semRandomUUID);
      expect(id).toMatch(V4);
      ids.add(id);
    }
    expect(ids.size).toBe(2000);
  });

  it('aceito pelo mesmo formato que o servidor valida (z.uuid)', () => {
    expect(uuidv4()).toMatch(V4);
  });
});

describe('uuidFromBytes', () => {
  it('força versão 4 e variante RFC mesmo com bytes extremos', () => {
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidFromBytes(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('não altera o array recebido', () => {
    const bytes = new Uint8Array(16).fill(0xff);
    uuidFromBytes(bytes);
    expect(bytes[6]).toBe(0xff);
  });

  it('rejeita tamanho errado', () => {
    expect(() => uuidFromBytes(new Uint8Array(15))).toThrow();
  });
});
