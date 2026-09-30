import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 90, b: 60 } } });

export const jpeg = (width = 200, height = 100) => solid(width, height).jpeg().toBuffer();
export const png = (width = 120, height = 80) => solid(width, height).png().toBuffer();
export const webp = (width = 120, height = 80) => solid(width, height).webp().toBuffer();

/** JPEG com orientação EXIF 6 (girar 90°) e coordenadas GPS + fabricante da câmera. */
export const jpegWithExifAndGps = (width = 100, height = 50) =>
  solid(width, height)
    .withExif({
      IFD0: { Make: 'CameraSecreta' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 32/1 3360/100',
        GPSLongitudeRef: 'W',
        GPSLongitude: '46/1 38/1 5760/100',
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

/** JPEG grande e "ruidoso" (não comprime bem), cortado ao meio: decodificação falha. */
export async function truncatedJpeg() {
  const noise = randomBytes(300 * 300 * 3);
  const full = await sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).jpeg().toBuffer();
  return full.subarray(0, Math.floor(full.length / 2));
}

/** PNG de ~56 MP (acima do limite de 50 MP) que ocupa pouquíssimos bytes. */
export const hugePixelsPng = () =>
  sharp(Buffer.alloc(8000 * 7000), { raw: { width: 8000, height: 7000, channels: 1 }, limitInputPixels: false })
    .png({ compressionLevel: 9 })
    .toBuffer();

export const notAnImage = () => Buffer.from('isto é um texto, não uma imagem '.repeat(20));
export const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]);
