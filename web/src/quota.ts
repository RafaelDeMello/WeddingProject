// Como mostrar a cota ao convidado (pílula de fotos e mensagem de limite).
import { TOTAL_QUOTA_MESSAGE, rateLimitMessage, type Quota } from './api';

export interface QuotaView {
  /** Fotos que ainda dá para enviar agora, descontando as que estão na fila. */
  available: number;
  /** Texto depois do número na pílula. */
  suffix: string;
  /** Mensagem no lugar da pílula quando não dá para enviar; null se ainda dá. */
  limitMessage: string | null;
}

/**
 * "N fotos disponíveis agora" quando quem limita é a janela deslizante;
 * "N fotos restantes" quando quem limita é o total (não volta a liberar).
 */
export function quotaView(quota: Quota, pending: number, nowMs: number): QuotaView {
  const available = Math.max(0, quota.remainingInWindow - pending);
  const totalLeft = Math.max(0, quota.remainingTotal - pending);
  // remainingInWindow já vem limitado pelo total: se empatam, é o total que restringe.
  const totalBinding = quota.remainingTotal <= quota.remainingInWindow;

  const suffix = totalBinding
    ? available === 1
      ? 'foto restante'
      : 'fotos restantes'
    : available === 1
      ? 'foto disponível agora'
      : 'fotos disponíveis agora';

  let limitMessage: string | null = null;
  if (available <= 0) {
    if (totalLeft <= 0) {
      limitMessage = TOTAL_QUOTA_MESSAGE;
    } else {
      const resetsAt = quota.resetsAt ? Date.parse(quota.resetsAt) : NaN;
      limitMessage = rateLimitMessage(
        Number.isFinite(resetsAt) ? Math.max(1, Math.ceil((resetsAt - nowMs) / 1000)) : undefined,
      );
    }
  }
  return { available, suffix, limitMessage };
}
