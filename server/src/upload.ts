import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import type { Env } from './env.js';
import { sendError } from './errors.js';

export const PHOTO_FIELD = 'photo';

/**
 * Lê o multipart em memória. Limites: 1 arquivo, MAX_UPLOAD_BYTES, 5 campos de texto de até 1 KB.
 * Erros do multer viram respostas no formato padrão; nada vaza como 500.
 */
export function photoUpload(env: Env): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: env.MAX_UPLOAD_BYTES,
      fields: 5,
      fieldSize: 1024,
      parts: 6,
    },
  }).single(PHOTO_FIELD);

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();

      if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 413, 'file_too_large', 'A foto é grande demais.');
      }
      if (err instanceof MulterError) {
        // Arquivo extra, campo com outro nome, campos demais ou grandes demais.
        return sendError(res, 400, 'invalid_upload', 'Envio inválido.');
      }
      // Multipart malformado ou interrompido (erros do busboy).
      req.log.warn({ err }, 'multipart inválido');
      return sendError(res, 400, 'invalid_upload', 'Envio inválido.');
    });
  };
}
