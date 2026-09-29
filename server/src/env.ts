import path from 'node:path';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const isoWithOffset = z.iso
  .datetime({ offset: true, local: false })
  .refine((v) => !v.endsWith('Z'), 'use um offset explícito, ex.: -03:00')
  .transform((v) => new Date(v));
const secret = (min: number) =>
  z
    .string()
    .min(min, `mínimo de ${min} caracteres`)
    .refine((v) => !v.includes('<'), 'substitua o valor de exemplo');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']),
    PORT: z.coerce.number().int().min(1).max(65535),
    TZ: z.string().min(1),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }),
    EVENT_SLUG: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/, 'use 3–64 caracteres [A-Za-z0-9_-]'),
    EVENT_NAME: z.string().trim().min(1).max(120),
    UPLOAD_OPENS_AT: isoWithOffset,
    UPLOAD_CLOSES_AT: isoWithOffset,
    GUEST_WINDOW_MINUTES: positiveInt,
    GUEST_MAX_PER_WINDOW: positiveInt,
    GUEST_MAX_TOTAL: positiveInt,
    IP_MAX_UPLOADS_PER_WINDOW: positiveInt,
    MAX_UPLOAD_BYTES: positiveInt,
    MIN_FREE_DISK_MB: z.coerce.number().int().min(0),
    SESSION_SECRET: secret(32),
    ADMIN_USER: secret(1),
    ADMIN_PASSWORD: secret(12),
    DATA_DIR: z.string().min(1),
    DATABASE_URL: z.string().startsWith('file:', 'deve começar com file:'),
  })
  .superRefine((env, ctx) => {
    if (env.UPLOAD_CLOSES_AT <= env.UPLOAD_OPENS_AT) {
      ctx.addIssue({
        code: 'custom',
        path: ['UPLOAD_CLOSES_AT'],
        message: 'deve ser posterior a UPLOAD_OPENS_AT',
      });
    }
    if (env.NODE_ENV === 'production' && !env.PUBLIC_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'deve usar https em produção',
      });
    }
  })
  .transform((env) => ({
    ...env,
    // Só a origem (sem barra final ou caminho), para comparar com o header Origin.
    PUBLIC_BASE_URL: new URL(env.PUBLIC_BASE_URL).origin,
    DATA_DIR: path.resolve(env.DATA_DIR),
  }));

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(`Variáveis de ambiente inválidas:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
