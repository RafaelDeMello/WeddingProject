// Câmera pela própria página (getUserMedia). Qualquer falha leva ao fallback <input capture>.

export type Facing = 'environment' | 'user';

export type CameraFailure = 'unsupported' | 'denied' | 'unavailable' | 'error';

export class CameraError extends Error {
  constructor(readonly reason: CameraFailure) {
    super(reason);
    this.name = 'CameraError';
  }
}

export function hasGetUserMedia(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export async function openCamera(facing: Facing): Promise<MediaStream> {
  if (!hasGetUserMedia()) throw new CameraError('unsupported');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // `ideal` e não `exact`: se o aparelho não tiver a câmera pedida, usa a que houver.
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
      throw new CameraError('unavailable');
    }
    throw new CameraError('error');
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function cameraFailureMessage(reason: CameraFailure): string {
  switch (reason) {
    case 'denied':
      return 'Sem permissão para usar a câmera. Você ainda pode tirar a foto pelo botão abaixo.';
    case 'unsupported':
      return 'Este navegador não abre a câmera na página. Use o botão abaixo.';
    case 'unavailable':
      return 'Não foi possível abrir a câmera. Use o botão abaixo.';
    case 'error':
      return 'A câmera falhou. Use o botão abaixo.';
  }
}

/**
 * Espelhar? Só a câmera frontal. Usa a câmera que o aparelho realmente abriu
 * (`facingMode` do track), porque `ideal` pode cair na frontal num aparelho sem traseira;
 * se o aparelho não informar, vale a que foi pedida.
 * O mesmo valor vale para o preview ao vivo e para a captura: a foto sai igual ao que se viu.
 */
export function shouldMirror(requested: Facing, actual: string | undefined): boolean {
  if (actual === 'user') return true;
  if (actual === 'environment') return false;
  return requested === 'user';
}

export function actualFacing(stream: MediaStream): string | undefined {
  const track = stream.getVideoTracks()[0];
  return typeof track?.getSettings === 'function' ? track.getSettings().facingMode : undefined;
}
