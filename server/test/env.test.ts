import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/env.js';
import { baseEnv } from './helpers.js';

const parse = (overrides: Record<string, string | undefined>) => parseEnv({ ...baseEnv, ...overrides });

describe('parseEnv', () => {
  it('aceita um ambiente válido e converte tipos', () => {
    const env = parse({ PUBLIC_BASE_URL: 'https://weddingrafessa.example.com/', DATA_DIR: 'rel/data' });
    expect(env.PORT).toBe(3000);
    expect(env.GUEST_MAX_TOTAL).toBe(150);
    expect(env.UPLOAD_OPENS_AT).toBeInstanceOf(Date);
    expect(env.UPLOAD_OPENS_AT.toISOString()).toBe('2026-01-01T03:00:00.000Z');
    expect(env.PUBLIC_BASE_URL).toBe('https://weddingrafessa.example.com');
    expect(path.isAbsolute(env.DATA_DIR)).toBe(true);
  });

  it.each([
    ['SESSION_SECRET ausente', { SESSION_SECRET: undefined }],
    ['SESSION_SECRET curto', { SESSION_SECRET: 'curto' }],
    ['ADMIN_PASSWORD com valor de exemplo', { ADMIN_PASSWORD: '<openssl rand -base64 24>' }],
    ['NODE_ENV desconhecido', { NODE_ENV: 'staging' }],
    ['PORT não numérica', { PORT: 'abc' }],
    ['limite zero', { GUEST_MAX_PER_WINDOW: '0' }],
    ['data sem offset', { UPLOAD_OPENS_AT: '2026-10-03T00:00:00' }],
    ['data em UTC (Z) em vez de offset explícito', { UPLOAD_OPENS_AT: '2026-10-03T03:00:00Z' }],
    ['fechamento antes da abertura', { UPLOAD_CLOSES_AT: '2025-12-31T00:00:00-03:00' }],
    ['slug com caracteres inválidos', { EVENT_SLUG: '../x' }],
    ['DATABASE_URL sem file:', { DATABASE_URL: 'postgres://x' }],
    ['http em produção', { NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://weddingrafessa.example.com' }],
  ])('rejeita: %s', (_label, overrides) => {
    expect(() => parse(overrides)).toThrow(EnvError);
  });

  it('aceita http fora de produção (dev local)', () => {
    expect(parse({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5173' }).PUBLIC_BASE_URL).toBe(
      'http://localhost:5173',
    );
  });

  it('a mensagem de erro aponta a variável problemática', () => {
    expect(() => parse({ SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
  });
});
