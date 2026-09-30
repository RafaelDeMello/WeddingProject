import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { adminAuth } from '../adminAuth.js';
import { sendError, sendRateLimited } from '../errors.js';
import { fileStamp, streamPhotosZip } from '../zipExport.js';

/** Quanto o cliente deve esperar antes de tentar outra exportação quando já há uma em andamento. */
const EXPORT_RETRY_SECONDS = 30;

export function adminRoutes({ env, prisma, logger, now }: AppDeps) {
  const router = Router();
  // Tudo de /admin e /api/admin passa por aqui: no-store, limite de falhas e Basic Auth.
  router.use(['/admin', '/api/admin'], ...adminAuth(env));

  // Uma exportação por vez: ela lê milhares de arquivos numa VPS de 1 CPU, e assim um clique repetido
  // (ou alguém com a senha) não derruba o resto do app.
  let exporting = false;

  router.get('/api/admin/export.zip', async (req, res) => {
    if (exporting) {
      return void sendRateLimited(res, EXPORT_RETRY_SECONDS, 'Já existe uma exportação em andamento.', {
        code: 'export_in_progress',
        appendWait: false,
      });
    }
    exporting = true;

    const controller = new AbortController();
    // 'close' vem ao terminar e também se o cliente desconectar no meio.
    res.once('close', () => controller.abort());

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="weddingrafessa-fotos-${fileStamp(now())}.zip"`);
    const startedAt = Date.now();
    try {
      const summary = await streamPhotosZip({
        prisma,
        dataDir: env.DATA_DIR,
        output: res,
        signal: controller.signal,
        logger: req.log ?? logger,
      });
      (req.log ?? logger).info(
        { ...summary, aborted: controller.signal.aborted, ms: Date.now() - startedAt },
        'exportação do ZIP terminou',
      );
    } catch (err) {
      (req.log ?? logger).error({ err }, 'erro durante a exportação do ZIP');
      if (res.headersSent) {
        res.destroy(err as Error); // já começou a enviar: o download quebra (melhor que um ZIP truncado "válido")
      } else {
        res.removeHeader('Content-Disposition');
        res.type('json');
        sendError(res, 500, 'internal_error', 'Erro interno.');
      }
    } finally {
      exporting = false;
    }
  });

  return router;
}
