import type { ErrorRequestHandler, RequestHandler, Response } from 'express';

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

/** 429 padrão: `retryAfterSeconds` no corpo e header `Retry-After`. */
export function sendRateLimited(res: Response, retryAfterSeconds: number, reason: string) {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const minutes = Math.ceil(seconds / 60);
  res.set('Retry-After', String(seconds));
  return sendError(
    res,
    429,
    'rate_limited',
    `${reason} Tente novamente em ${minutes} min.`,
    { retryAfterSeconds: seconds },
  );
}

export const notFound: RequestHandler = (_req, res) => {
  sendError(res, 404, 'not_found', 'Recurso não encontrado.');
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Erros do body-parser (express.json) trazem status e type.
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status === 413) return sendError(res, 413, 'payload_too_large', 'Requisição grande demais.');
  if (status === 400 && err?.type === 'entity.parse.failed') {
    return sendError(res, 400, 'invalid_json', 'JSON inválido.');
  }
  if (status >= 500) req.log.error({ err }, 'erro não tratado');
  return sendError(res, status >= 500 ? 500 : status, 'internal_error', 'Erro interno.');
};
