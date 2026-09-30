// Compressão no cliente: JPEG, lado maior 1600px, qualidade 0.8 (alvo ~300 KB).

export const MAX_SIDE = 1600;
export const JPEG_QUALITY = 0.8;

/** Dimensões que cabem em `max` mantendo a proporção; nunca amplia. */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error('Dimensões inválidas.');
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawToJpeg(source: CanvasImageSource, width: number, height: number, mirror = false): Promise<Blob> {
  const size = fitWithin(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas indisponível.'));
  ctx.imageSmoothingQuality = 'high';
  if (mirror) {
    // Câmera frontal: a foto sai espelhada como o preview ao vivo.
    ctx.translate(size.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // Libera a memória do canvas logo (iOS tem limite baixo de memória de canvas).
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error('Não foi possível gerar a imagem.'));
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/** Captura o quadro atual do vídeo da câmera; `mirror` só para a frontal (ver shouldMirror). */
export function captureVideoFrame(video: HTMLVideoElement, mirror = false): Promise<Blob> {
  if (!video.videoWidth || !video.videoHeight) return Promise.reject(new Error('A câmera ainda não está pronta.'));
  return drawToJpeg(video, video.videoWidth, video.videoHeight, mirror);
}

/** Comprime o arquivo do fallback. O <img> já aplica a orientação EXIF nos navegadores atuais. */
export async function compressFile(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return await drawToJpeg(img, img.naturalWidth, img.naturalHeight);
  } catch {
    throw new Error('Não foi possível ler essa imagem. Tente tirar outra.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
