import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  CameraError,
  actualFacing,
  cameraFailureMessage,
  openCamera,
  shouldMirror,
  stopStream,
  type CameraFailure,
  type Facing,
} from '../camera';
import { captureVideoFrame, compressFile } from '../compress';

interface Props {
  /** Captura bloqueada (ex.: cota esgotada ou preview aberto). */
  disabled: boolean;
  /** Mantém a câmera aberta mas escondida enquanto o preview está na tela (evita pedir permissão de novo). */
  hidden: boolean;
  onCapture(photo: Blob): void;
  /** Saudação e cota: sobre o vídeo (faixa superior) ou acima do cartão do fallback. */
  topBar: ReactNode;
  /** Pílula de status dos envios, na faixa inferior. */
  statusPill: ReactNode;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export function CameraView({ disabled, hidden, onCapture, topBar, statusPill }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<Facing>('environment');
  const [ready, setReady] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = usePageVisible();

  useEffect(() => {
    // Com a aba em segundo plano, a câmera é liberada; volta ao reabrir.
    if (!visible || failure) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    setReady(false);
    openCamera(facing)
      .then((s) => {
        if (cancelled) return stopStream(s);
        stream = s;
        setMirror(shouldMirror(facing, actualFacing(s)));
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        void video.play().catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof CameraError ? err.reason : 'error');
      });
    return () => {
      cancelled = true;
      stopStream(stream);
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [facing, visible, failure]);

  async function capture() {
    const video = videoRef.current;
    if (!video || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      onCapture(await captureVideoFrame(video, mirror));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível tirar a foto.');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || disabled) return;
    setBusy(true);
    setError(null);
    try {
      onCapture(await compressFile(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível ler essa imagem.');
    } finally {
      setBusy(false);
    }
  }

  const fileInput = (
    <input
      ref={fileRef}
      className="visually-hidden"
      type="file"
      accept="image/*"
      capture="environment"
      onChange={onFile}
      disabled={disabled || busy}
    />
  );

  return (
    <section className={`camera ${failure ? 'camera-fallback' : 'camera-live'}${hidden ? ' is-hidden' : ''}`}>
      {failure ? (
        <>
          {topBar}
          <div className="card fallback-card">
            <div className="ornament" aria-hidden="true" />
            <p>{cameraFailureMessage(failure)}</p>
            <button
              type="button"
              className="primary"
              disabled={disabled || busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? 'Preparando…' : 'Tirar foto'}
            </button>
            {error && <p className="error">{error}</p>}
            {statusPill && <div className="fallback-status">{statusPill}</div>}
          </div>
          {fileInput}
        </>
      ) : (
        <>
          <video
            ref={videoRef}
            className={mirror ? 'viewfinder mirror' : 'viewfinder'}
            playsInline
            muted
            autoPlay
            onLoadedData={() => setReady(true)}
          />
          {!ready && <p className="viewfinder-status">Abrindo a câmera…</p>}
          <div className="band band-top">{topBar}</div>
          <div className="band band-bottom">
            {error && <p className="band-error">{error}</p>}
            <div className="camera-actions">
              <button
                type="button"
                className="ghost"
                disabled={!ready || busy}
                onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
              >
                Virar câmera
              </button>
              <button
                type="button"
                className="shutter"
                aria-label="Tirar foto"
                disabled={!ready || busy || disabled}
                onClick={capture}
              />
              <span className="camera-actions-status">{statusPill}</span>
            </div>
            <button
              type="button"
              className="link"
              disabled={disabled || busy}
              onClick={() => fileRef.current?.click()}
            >
              Problemas com a câmera? Use a câmera do celular
            </button>
          </div>
          {fileInput}
        </>
      )}
    </section>
  );
}
