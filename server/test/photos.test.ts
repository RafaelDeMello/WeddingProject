import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import * as fx from './fixtures.js';
import { ORIGIN } from './helpers.js';
import { expectDiskConsistent, signIn, T0, upload, uploadOk, useContext } from './photoHelpers.js';

const setup = useContext();

describe('POST /api/photos — upload válido', () => {
  it('201 com id e cota; grava foto e miniatura em caminhos gerados pelo servidor', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const clientUploadId = randomUUID();

    const res = await upload(c, await fx.jpeg(3000, 1500), {
      cookie,
      id: clientUploadId,
      filename: '../../etc/passwd.jpg', // input do usuário nunca vira caminho
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      quota: { remainingInWindow: 9, remainingTotal: 149, resetsAt: new Date(T0.getTime() + 10 * 60_000).toISOString() },
    });

    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(photo).toMatchObject({ guestId, clientUploadId, width: 2000, height: 1000, hiddenAt: null, createdAt: T0 });
    expect(photo.filePath).toBe(`photos/2026-10-04/${photo.id}.jpg`);
    expect(photo.thumbPath).toBe(`thumbs/${photo.id}.jpg`);

    const saved = readFileSync(path.join(c.env.DATA_DIR, photo.filePath));
    expect(photo.sizeBytes).toBe(saved.length);
    expect(saved.subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG
    const thumb = await sharp(readFileSync(path.join(c.env.DATA_DIR, photo.thumbPath))).metadata();
    expect(thumb).toMatchObject({ format: 'jpeg', width: 400, height: 200 });
    await expectDiskConsistent(c, 1);
  });

  it('não amplia fotos pequenas e limita o lado maior a 2000px', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const small = await uploadOk(c, await fx.jpeg(200, 100), cookie);
    const tall = await uploadOk(c, await fx.jpeg(1500, 4000), cookie);
    const [a, b] = await Promise.all([
      c.prisma.photo.findUniqueOrThrow({ where: { id: small.body.id } }),
      c.prisma.photo.findUniqueOrThrow({ where: { id: tall.body.id } }),
    ]);
    expect([a.width, a.height]).toEqual([200, 100]);
    expect([b.width, b.height]).toEqual([750, 2000]);
  });

  it.each([
    ['PNG', () => fx.png()],
    ['WebP', () => fx.webp()],
  ])('aceita %s e salva como JPEG', async (_label, make) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, await make(), cookie, undefined, { filename: 'x.bin', contentType: 'application/octet-stream' });
    expect(res.status).toBe(201);
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id: res.body.id } });
    expect((await sharp(path.join(c.env.DATA_DIR, photo.filePath)).metadata()).format).toBe('jpeg');
  });

  it('clientUploadId em maiúsculas é normalizado (mesmo id que em minúsculas)', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const id = randomUUID();
    const first = await uploadOk(c, await fx.jpeg(), cookie, id.toUpperCase());
    const second = await uploadOk(c, await fx.jpeg(), cookie, id);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id: first.body.id } })).clientUploadId).toBe(id);
  });
});

describe('POST /api/photos — EXIF e GPS', () => {
  it('remove EXIF/GPS do arquivo e da miniatura, aplicando a orientação antes', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);

    const original = await fx.jpegWithExifAndGps(100, 50);
    const before = await sharp(original).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined(); // o fixture realmente tem EXIF...
    expect(original.includes(Buffer.from('CameraSecreta'))).toBe(true);
    expect(before.exif!.includes(Buffer.from([0x25, 0x88]))).toBe(true); // ponteiro do bloco GPS (tag 0x8825)

    const res = await uploadOk(c, original, cookie);
    expect(res.status).toBe(201);
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id: res.body.id } });

    for (const rel of [photo.filePath, photo.thumbPath]) {
      const bytes = readFileSync(path.join(c.env.DATA_DIR, rel));
      const meta = await sharp(bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
      expect(bytes.includes(Buffer.from('CameraSecreta'))).toBe(false);
    }
    // 100×50 com orientação 6 vira retrato 50×100 (os pixels foram girados de fato).
    expect([photo.width, photo.height]).toEqual([50, 100]);
  });
});

describe('POST /api/photos — validação do arquivo', () => {
  it.each([
    ['texto com extensão .jpg e Content-Type image/jpeg', () => fx.notAnImage()],
    ['GIF', () => fx.gif()],
  ])('%s → 415 unsupported_media_type e nada gravado', async (_label, make) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, make(), cookie, undefined, { filename: 'foto.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('unsupported_media_type');
    await expectDiskConsistent(c, 0);
  });

  it('JPEG verdadeiro enviado como .txt/text/plain é aceito: só valem os magic bytes', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, await fx.jpeg(), cookie, undefined, { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(201);
  });

  it('JPEG truncado → 422 invalid_image', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, await fx.truncatedJpeg(), cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_image');
    await expectDiskConsistent(c, 0);
  });

  it('imagem acima de 50 MP (mesmo pequena em bytes) → 422 invalid_image', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const big = await fx.hugePixelsPng();
    expect(big.length).toBeLessThan(8 * 1024 * 1024);
    const res = await uploadOk(c, big, cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_image');
    await expectDiskConsistent(c, 0);
  });
});

describe('POST /api/photos — limite de tamanho e erros do multer', () => {
  it('1 byte acima de MAX_UPLOAD_BYTES → 413 file_too_large', async () => {
    const image = await fx.jpeg(400, 300);
    const c = await setup({ env: { MAX_UPLOAD_BYTES: String(image.length - 1) } });
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, image, cookie);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    await expectDiskConsistent(c, 0);
  });

  it('exatamente MAX_UPLOAD_BYTES → aceito', async () => {
    const image = await fx.jpeg(400, 300);
    const c = await setup({ env: { MAX_UPLOAD_BYTES: String(image.length) } });
    const { cookie } = await signIn(c);
    expect((await uploadOk(c, image, cookie)).status).toBe(201);
  });

  it('arquivo de 9 MB com o limite padrão de 8 MB → 413', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, Buffer.alloc(9 * 1024 * 1024, 1), cookie);
    expect(res.status).toBe(413);
  });

  it('sem arquivo → 400 missing_photo', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await upload(c, null, { cookie, id: randomUUID() }).field('outro', 'x');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_photo');
  });

  it('corpo JSON em vez de multipart → 400 missing_photo', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await request(c.app)
      .post('/api/photos')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({ clientUploadId: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_photo');
  });

  it('dois arquivos → 400 invalid_upload', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const image = await fx.jpeg();
    const res = await upload(c, image, { cookie, id: randomUUID() }).attach('photo', image, 'segunda.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_upload');
    await expectDiskConsistent(c, 0);
  });

  it('campo de arquivo com outro nome → 400 invalid_upload', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await upload(c, await fx.jpeg(), { cookie, id: randomUUID(), field: 'file' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_upload');
  });

  it('mais de 5 campos de texto → 400 invalid_upload', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const req = upload(c, await fx.jpeg(), { cookie, id: randomUUID() });
    for (let i = 0; i < 5; i++) req.field(`extra${i}`, 'x');
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_upload');
  });

  it('campo de texto acima de 1 KB → 400 invalid_upload', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await upload(c, await fx.jpeg(), { cookie, id: randomUUID() }).field('nota', 'x'.repeat(2000));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_upload');
  });

  it('campo de texto desconhecido → 400 validation_error', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await upload(c, await fx.jpeg(), { cookie, id: randomUUID() }).field('guestId', 'outro');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    await expectDiskConsistent(c, 0);
  });

  it.each([
    ['ausente', undefined],
    ['texto qualquer', 'nao-e-uuid'],
    ['id de 32 hex sem hífens', 'a'.repeat(32)],
    ['uuid com lixo no final', `${randomUUID()}x`],
    ['vazio', ''],
  ])('clientUploadId %s → 400 validation_error', async (_label, id) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await upload(c, await fx.jpeg(), { cookie, id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    await expectDiskConsistent(c, 0);
  });

  it('multipart truncado no meio do arquivo → 400 invalid_upload (ou conexão encerrada), sem 500 nem arquivos', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await request(c.app)
      .post('/api/photos')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .set('Content-Type', 'multipart/form-data; boundary=xyz')
      .send('--xyz\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nabc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_upload');
    await expectDiskConsistent(c, 0);
  });
});

describe('POST /api/photos — sessão, janela e Origin (ordem das checagens)', () => {
  it('sem sessão → 401', async () => {
    const c = await setup();
    const res = await upload(c, await fx.jpeg(), { id: randomUUID() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('cookie de guest inexistente → 401', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await c.prisma.guest.delete({ where: { id: guestId } });
    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(401);
  });

  it.each([
    ['ausente', null],
    ['de outro domínio', 'https://evil.example'],
  ])('Origin %s → 403 invalid_origin', async (_label, origin) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await upload(c, await fx.jpeg(), { cookie, id: randomUUID(), origin });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_origin');
    await expectDiskConsistent(c, 0);
  });

  it.each([
    ['antes da abertura', new Date('2026-10-02T23:59:59-03:00')],
    ['depois do encerramento', new Date('2026-10-07T00:00:00-03:00')],
  ])('fora da janela (%s) → 403 upload_closed, mesmo com sessão válida', async (_label, later) => {
    let clock = T0;
    const c = await setup({ now: () => clock });
    const { cookie } = await signIn(c);
    clock = later;
    const res = await uploadOk(c, await fx.jpeg(), cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('upload_closed');
    await expectDiskConsistent(c, 0);
  });
});
