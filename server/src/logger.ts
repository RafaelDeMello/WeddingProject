import { randomUUID } from 'node:crypto';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

export function createLogger(nodeEnv: string): Logger {
  return pino({
    level: nodeEnv === 'test' ? 'silent' : 'info',
    base: undefined,
  });
}

/** Log por request sem IP, cookies nem Authorization — só método, URL e status. */
export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: () => randomUUID(),
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
