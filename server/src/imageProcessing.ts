import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

// Sem cache interno: com fotos diferentes a cada request ele só ocuparia memória.
sharp.cache(false);

export const MAX_INPUT_PIXELS = 50_000_000;
export const MAX_PHOTO_SIDE = 2000;
export const THUMB_SIDE = 400;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class UnsupportedMediaError extends Error {}
export class InvalidImageError extends Error {}

export interface ProcessedImage {
  photo: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

/** Só olha os magic bytes: Content-Type e nome do arquivo enviados pelo cliente são ignorados. */
export async function assertAllowedImage(buffer: Buffer): Promise<void> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_MIME.has(detected.mime)) {
    throw new UnsupportedMediaError('Formato não suportado.');
  }
}

/**
 * Aplica a orientação EXIF, limita a 2000px, recodifica em JPEG q85 e gera a miniatura de 400px.
 * O sharp não copia metadados por padrão, então EXIF/GPS não chegam ao arquivo final.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_PHOTO_SIDE, height: MAX_PHOTO_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });

    const thumb = await sharp(data)
      .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    return { photo: data, thumb, width: info.width, height: info.height };
  } catch (err) {
    throw new InvalidImageError(err instanceof Error ? err.message : 'Imagem inválida.');
  }
}
