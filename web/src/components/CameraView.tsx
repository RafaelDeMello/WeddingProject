import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { CameraError, cameraFailureMessage, openCamera, stopStream, type CameraFailure, type Facing } from '../camera';
import { captureVideoFrame, compressFile } from '../compress';

interface Props {
  /** Captura bloqueada (ex.: cota esgotada ou preview aberto). */
  disabled: boolean;
  /** Mantém a câmera aberta mas escondida enquanto o preview está na tela (evita pedir permissão de novo). */
  hidden: boolean;
  onCapture(photo: Blob): void;
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

export function CameraView({ disabled, hidden, onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<Facing>('environment');
  const [ready, setReady] = useState(false);
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
      onCapture(await captureVideoFrame(video));
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
    <section className={hidden ? 'camera is-hidden' : 'camera'}>
      {failure ? (
        <div className="camera-fallback">
          <p>{cameraFailureMessage(failure)}</p>
          <button type="button" className="primary" disabled={disabled || busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Preparando…' : 'Tirar foto'}
          </button>
          {fileInput}
        </div>
      ) : (
        <>
          <div className="viewfinder">
            <video
              ref={videoRef}
              className={facing === 'user' ? 'mirror' : undefined}
              playsInline
              muted
              autoPlay
              onLoadedData={() => setReady(true)}
            />
            {!ready && <p className="viewfinder-status">Abrindo a câmera…</p>}
          </div>
          <div className="camera-actions">
            <button
              type="button"
              className="secondary"
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
            <span className="camera-actions-spacer" />
          </div>
          <button type="button" className="link" disabled={disabled || busy} onClick={() => fileRef.current?.click()}>
            Problemas com a câmera? Use a câmera do celular
          </button>
          {fileInput}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
