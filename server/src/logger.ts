import { pino, type Logger } from 'pino';

export function createLogger(nodeEnv: string): Logger {
  return pino({
    level: nodeEnv === 'test' ? 'silent' : 'info',
    base: undefined,
  });
}

declare global {
  namespace Express {
    interface Request {
      log?: Logger;
    }
  }
}
