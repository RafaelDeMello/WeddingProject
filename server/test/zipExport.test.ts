import { randomUUID } from 'node:crypto';
import { closeSync, createWriteStream, linkSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { entryName, fileStamp, guestFolder, slugify, timeOfDay, zipTimestamp } from '../src/zipExport.js';
import { baseEnv } from './helpers.js';
import { type Ctx, T0, useContext } from './photoHelpers.js';
import { listZip, listZipFile, readEntry } from './zipReader.js';

const setup = useContext();
const AUTH = `Basic ${Buffer.from(`${baseEnv.ADMIN_USER}:${baseEnv.ADMIN_PASSWORD}`).toString('base64')}`;
const ZIP = '/api/admin/export.zip';
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function download(c: Ctx) {
  const res = await request(c.app)
    .get(ZIP)
    .set('Authorization', AUTH)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { res, zip: res.body as Buffer };
}

interface Spec {
  id?: string;
  createdAt: Date;
  hiddenAt?: Date | null;
  content?: string | Buffer;
  /** true = não cria o arquivo no disco */
  missing?: boolean;
}

/**
 * Muitos nomes para o mesmo conteúdo, sem ocupar disco (hard links). O NTFS aceita ~1023 links por arquivo,
 * então a cada 900 nomes um novo arquivo-base é criado.
 */
function linker(dir: string, content: Buffer) {
  mkdirSync(dir, { recursive: true });
  let base = '';
  let count = 0;
  return (target: string) => {
    if (count % 900 === 0) {
      base = path.join(dir, `base-${count}.bin`);
      writeFileSync(base, content);
    }
    count++;
    linkSync(base, target);
  };
}

/** Cria as fotos no banco e os arquivos em DATA_DIR. Devolve os ids na ordem dada. */
async function addPhotos(c: Ctx, guest: { id: string }, specs: Spec[]): Promise<string[]> {
  const rows = specs.map((s) => {
    const id = s.id ?? randomUUID();
    return { spec: s, id, filePath: `photos/2026-10-04/${id}.jpg` };
  });
  mkdirSync(path.join(c.env.DATA_DIR, 'photos/2026-10-04'), { recursive: true });
  for (const r of rows) {
    if (!r.spec.missing) writeFileSync(path.join(c.env.DATA_DIR, r.filePath), r.spec.content ?? `conteudo-${r.id}`);
  }
  await c.prisma.photo.createMany({
    data: rows.map((r) => ({
      id: r.id,
      guestId: guest.id,
      clientUploadId: randomUUID(),
      filePath: r.filePath,
      thumbPath: `thumbs/${r.id}.jpg`,
      sizeBytes: 1,
      width: 1,
      height: 1,
      createdAt: r.spec.createdAt,
      hiddenAt: r.spec.hiddenAt ?? null,
      visibilityChangedAt: r.spec.hiddenAt ?? null,
    })),
  });
  return rows.map((r) => r.id);
}

describe('nomes: slugify, pasta do convidado e hora', () => {
  it.each([
    ['José da Silva', 'jose-da-silva'],
    ['  Ana   Maria  ', 'ana-maria'],
    ['ÁÉÍÓÚ àèìòù ãõç', 'aeiou-aeiou-aoc'],
    ['João & Maria!!!', 'joao-maria'],
    ['../../etc/passwd', 'etc-passwd'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j'],
    ['😀😀😀', 'convidado'],
    ['***', 'convidado'],
    ['', 'convidado'],
    ['Nome Muito Muito Muito Muito Muito Longo Mesmo Sim', 'nome-muito-muito-muito-muito-muito-longo'],
  ])('slugify(%j) → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
    expect(slugify(input).length).toBeLessThanOrEqual(40);
    expect(slugify(input)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('pasta = slug + 8 primeiros caracteres do guestId (convidados homônimos não se misturam)', () => {
    const a = guestFolder({ id: '11111111-aaaa-bbbb-cccc-000000000001', name: 'Ana' });
    const b = guestFolder({ id: '22222222-aaaa-bbbb-cccc-000000000002', name: 'Ana' });
    expect(a).toBe('ana-11111111');
    expect(b).toBe('ana-22222222');
  });

  it('HHmmss no horário de São Paulo, inclusive na virada do dia', () => {
    expect(timeOfDay(new Date('2026-10-04T23:05:09Z'))).toBe('200509');
    expect(timeOfDay(new Date('2026-10-04T02:30:00Z'))).toBe('233000');
    expect(timeOfDay(new Date('2026-10-04T03:00:00Z'))).toBe('000000');
    expect(timeOfDay(new Date('2026-10-04T14:00:07Z'))).toBe('110007');
    expect(fileStamp(new Date('2026-10-04T23:05:09Z'))).toBe('20261004-2005');
    expect(fileStamp(new Date('2026-10-04T02:30:00Z'))).toBe('20261003-2330');
  });

  it('zipTimestamp: os campos UTC da data devolvida são a hora de Brasília', () => {
    const d = zipTimestamp(new Date('2026-10-04T23:05:09Z'));
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]).toEqual([2026, 10, 4, 20, 5, 9]);
    const late = zipTimestamp(new Date('2026-10-04T02:30:00Z')); // ainda é o dia 3 em Brasília
    expect([late.getUTCDate(), late.getUTCHours()]).toEqual([3, 23]);
  });

  it('entryName: visíveis na pasta do convidado; ocultas em _ocultas/ com a mesma estrutura', () => {
    const guest = { id: 'abcdef12-0000-0000-0000-000000000000', name: 'Ana Lúcia' };
    const photo = { id: 'p1', createdAt: new Date('2026-10-04T23:05:09Z'), hiddenAt: null };
    expect(entryName(photo, guest)).toBe('ana-lucia-abcdef12/200509-p1.jpg');
    expect(entryName({ ...photo, hiddenAt: new Date() }, guest)).toBe('_ocultas/ana-lucia-abcdef12/200509-p1.jpg');
  });
});

describe('GET /api/admin/export.zip — conteúdo', () => {
  it('pastas por convidado, arquivos com o conteúdo original e ocultas/apagadas em _ocultas/', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana Lúcia' } });
    const bia = await c.prisma.guest.create({ data: { name: 'Bia/../Souza 😀' } });
    const [a1, a2, aHidden] = await addPhotos(c, ana, [
      { createdAt: new Date('2026-10-04T23:05:09Z') },
      { createdAt: new Date('2026-10-04T02:30:00Z'), content: Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]) },
      { createdAt: at(1), hiddenAt: at(2) },
    ]);
    const [b1] = await addPhotos(c, bia, [{ createdAt: at(3) }]);

    const { res, zip } = await download(c);
    expect(res.status).toBe(200);
    const entries = listZip(zip);
    const aFolder = `ana-lucia-${ana.id.slice(0, 8)}`;
    const bFolder = `bia-souza-${bia.id.slice(0, 8)}`;
    expect(entries.map((e) => e.name).sort()).toEqual(
      [
        `${aFolder}/200509-${a1}.jpg`,
        `${aFolder}/233000-${a2}.jpg`,
        `_ocultas/${aFolder}/200100-${aHidden}.jpg`,
        `${bFolder}/200300-${b1}.jpg`,
      ].sort(),
    );

    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(readEntry(zip, byName.get(`${aFolder}/200509-${a1}.jpg`)!).toString()).toBe(`conteudo-${a1}`);
    expect([...readEntry(zip, byName.get(`${aFolder}/233000-${a2}.jpg`)!)]).toEqual([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
    // A data gravada no ZIP é a hora de Brasília (20:05:09 → DOS guarda 2 em 2 segundos: 08), não UTC.
    expect(byName.get(`${aFolder}/200509-${a1}.jpg`)!.dos).toEqual({ year: 2026, month: 10, day: 4, hour: 20, minute: 5, second: 8 });
    expect(byName.get(`${aFolder}/233000-${a2}.jpg`)!.dos).toMatchObject({ day: 3, hour: 23, minute: 30 });
    // Tudo em STORE (JPEG não comprime).
    expect(new Set(entries.map((e) => e.method))).toEqual(new Set([0]));
    // Nada de "../" nem caminho absoluto nos nomes.
    for (const e of entries) {
      expect(e.name).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(e.name.startsWith('/')).toBe(false);
    }
  });

  it('foto apagada pelo dono (DELETE) vai para _ocultas/', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    const [id] = await addPhotos(c, ana, [{ createdAt: at(0) }]);
    await c.prisma.photo.update({ where: { id: id! }, data: { hiddenAt: at(1), visibilityChangedAt: at(1) } });
    const { zip } = await download(c);
    expect(listZip(zip).map((e) => e.name)).toEqual([`_ocultas/ana-${ana.id.slice(0, 8)}/200000-${id}.jpg`]);
  });

  it('cabeçalhos: application/zip, attachment com data e hora do evento, no-store', async () => {
    const c = await setup();
    const { res } = await download(c);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="weddingrafessa-fotos-20261004-2000.zip"');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sem nenhuma foto → ZIP vazio e válido', async () => {
    const c = await setup();
    const { res, zip } = await download(c);
    expect(res.status).toBe(200);
    expect(listZip(zip)).toEqual([]);
  });

  it('arquivo faltando no disco é pulado e listado em _faltando.txt; o resto vem normal', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    const [ok, gone] = await addPhotos(c, ana, [{ createdAt: at(0) }, { createdAt: at(1), missing: true }]);
    const { res, zip } = await download(c);
    expect(res.status).toBe(200);
    const entries = listZip(zip);
    expect(entries.map((e) => e.name).sort()).toEqual([`ana-${ana.id.slice(0, 8)}/200000-${ok}.jpg`, '_faltando.txt'].sort());
    const report = readEntry(zip, entries.find((e) => e.name === '_faltando.txt')!).toString();
    expect(report).toContain(gone!);
    expect(report).not.toContain(ok!);
  });

  it('sem faltas não existe _faltando.txt', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    await addPhotos(c, ana, [{ createdAt: at(0) }]);
    expect(listZip((await download(c)).zip).map((e) => e.name)).not.toContain('_faltando.txt');
  });

  it('caminho do banco que escapa de DATA_DIR nunca entra no ZIP (conta como faltando)', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    writeFileSync(path.join(c.env.DATA_DIR, '..', 'segredo.txt'), 'SEGREDO');
    const [id] = await addPhotos(c, ana, [{ createdAt: at(0), missing: true }]);
    await c.prisma.photo.update({ where: { id: id! }, data: { filePath: '../segredo.txt' } });
    const { zip } = await download(c);
    expect(zip.includes(Buffer.from('SEGREDO'))).toBe(false);
    expect(listZip(zip).map((e) => e.name)).toEqual(['_faltando.txt']);
  });

  it('mais fotos que o lote do banco (500): 1200 fotos, nenhuma perdida nem repetida', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    const bia = await c.prisma.guest.create({ data: { name: 'Bia' } });
    mkdirSync(path.join(c.env.DATA_DIR, 'photos/2026-10-04'), { recursive: true });
    const link = linker(path.join(c.env.DATA_DIR, 'bases'), Buffer.from('x'.repeat(1000)));
    const ids: string[] = [];
    const data = Array.from({ length: 1200 }, (_, i) => {
      const id = randomUUID();
      ids.push(id);
      link(path.join(c.env.DATA_DIR, `photos/2026-10-04/${id}.jpg`));
      return {
        id,
        guestId: i % 2 === 0 ? ana.id : bia.id,
        clientUploadId: randomUUID(),
        filePath: `photos/2026-10-04/${id}.jpg`,
        thumbPath: `thumbs/${id}.jpg`,
        sizeBytes: 1000,
        width: 1,
        height: 1,
        createdAt: new Date(T0.getTime() + i * 1000),
        hiddenAt: i % 10 === 0 ? at(5) : null,
        visibilityChangedAt: i % 10 === 0 ? at(5) : null,
      };
    });
    await c.prisma.photo.createMany({ data });

    const { res, zip } = await download(c);
    expect(res.status).toBe(200);
    const entries = listZip(zip);
    expect(entries).toHaveLength(1200);
    expect(new Set(entries.map((e) => e.name)).size).toBe(1200);
    const idOf = (name: string) => /-([0-9a-f-]{36})\.jpg$/.exec(name)![1];
    expect(new Set(entries.map((e) => idOf(e.name)))).toEqual(new Set(ids));
    expect(entries.filter((e) => e.name.startsWith('_ocultas/'))).toHaveLength(120);
    for (const e of entries) expect(e.size).toBe(1000);
  });
});

describe('uma exportação por vez e desconexão do cliente', () => {
  it('com uma exportação em andamento a segunda recebe 429 export_in_progress; ao cliente desconectar, libera', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    // 150 fotos de 1 MB (hard links): mais que os buffers do socket E que o teto da fila (100) — o produtor trava esperando vaga.
    mkdirSync(path.join(c.env.DATA_DIR, 'photos/2026-10-04'), { recursive: true });
    const link = linker(path.join(c.env.DATA_DIR, 'bases'), Buffer.alloc(1024 * 1024, 7));
    const data = Array.from({ length: 150 }, (_, i) => {
      const id = randomUUID();
      link(path.join(c.env.DATA_DIR, `photos/2026-10-04/${id}.jpg`));
      return {
        id,
        guestId: ana.id,
        clientUploadId: randomUUID(),
        filePath: `photos/2026-10-04/${id}.jpg`,
        thumbPath: `thumbs/${id}.jpg`,
        sizeBytes: 1,
        width: 1,
        height: 1,
        createdAt: new Date(T0.getTime() + i * 1000),
      };
    });
    await c.prisma.photo.createMany({ data });

    const server = c.app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      // Primeira exportação: o cliente recebe os cabeçalhos e PARA de ler (backpressure segura o servidor).
      const first = await new Promise<{ req: http.ClientRequest; res: IncomingMessage }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: ZIP, headers: { Authorization: AUTH } }, (res) => {
          res.pause();
          resolve({ req, res });
        });
        req.on('error', reject);
      });
      expect(first.res.statusCode).toBe(200);

      const second = await request(c.app).get(ZIP).set('Authorization', AUTH);
      expect(second.status).toBe(429);
      expect(second.body.error).toEqual({
        code: 'export_in_progress',
        message: expect.any(String),
        retryAfterSeconds: 30,
      });
      expect(second.headers['retry-after']).toBe('30');

      // O cliente desiste: o servidor aborta o archiver e libera a vaga.
      first.req.destroy();
      let status = 429;
      for (let i = 0; i < 100 && status === 429; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await request(c.app).get(ZIP).set('Authorization', AUTH)).status;
      }
      expect(status).toBe(200);
    } finally {
      server.close();
    }
  }, 60_000);

  it('sem credenciais a exportação nem começa (e não trava a vaga)', async () => {
    const c = await setup();
    expect((await request(c.app).get(ZIP)).status).toBe(401);
    expect((await request(c.app).get(ZIP).set('Authorization', AUTH)).status).toBe(200);
  });
});

describe('streaming com muitas fotos: a memória não cresce com o tamanho do ZIP', () => {
  it('2000 fotos de 256 KB (≈512 MB) passam pelo stream com pouca memória e o ZIP sai íntegro', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    const bia = await c.prisma.guest.create({ data: { name: 'Bia' } });
    const PHOTOS = 2000;
    const SIZE = 256 * 1024;

    mkdirSync(path.join(c.env.DATA_DIR, 'photos/2026-10-04'), { recursive: true });
    const content = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) content[i] = i % 251;
    const link = linker(path.join(c.env.DATA_DIR, 'bases'), content);
    const rows = Array.from({ length: PHOTOS }, (_, i) => {
      const id = randomUUID();
      link(path.join(c.env.DATA_DIR, `photos/2026-10-04/${id}.jpg`)); // mesmo dado, 2000 nomes: quase sem ocupar disco
      return {
        id,
        guestId: i % 2 === 0 ? ana.id : bia.id,
        clientUploadId: randomUUID(),
        filePath: `photos/2026-10-04/${id}.jpg`,
        thumbPath: `thumbs/${id}.jpg`,
        sizeBytes: SIZE,
        width: 1,
        height: 1,
        createdAt: new Date(T0.getTime() + i * 1000),
        hiddenAt: i % 20 === 0 ? at(9) : null,
        visibilityChangedAt: i % 20 === 0 ? at(9) : null,
      };
    });
    await c.prisma.photo.createMany({ data: rows });

    const out = path.join(c.env.DATA_DIR, '..', 'export-grande.zip');
    const server = c.app.listen(0);
    let peak = 0;
    const baseline = process.memoryUsage().rss;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: ZIP, headers: { Authorization: AUTH } }, (res) => {
          if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
          // Grava em disco sem guardar em memória: só o ZIP pronto é conferido depois.
          pipeline(res, createWriteStream(out)).then(() => resolve(), reject);
        });
        req.on('error', reject);
      });
    } finally {
      clearInterval(sampler);
      server.close();
    }

    const growthMb = (peak - baseline) / 1024 / 1024;
    const { entries, fileSize } = listZipFile(out);
    console.log(`ZIP: ${(fileSize / 1024 / 1024).toFixed(0)} MB, ${entries.length} entradas; crescimento de RSS no pico: ${growthMb.toFixed(0)} MB`);

    expect(entries).toHaveLength(PHOTOS);
    expect(new Set(entries.map((e) => e.name)).size).toBe(PHOTOS);
    expect(entries.every((e) => e.size === SIZE && e.method === 0)).toBe(true);
    expect(entries.filter((e) => e.name.startsWith('_ocultas/'))).toHaveLength(PHOTOS / 20);
    expect(fileSize).toBeGreaterThan(PHOTOS * SIZE); // passou ~512 MB pelo stream...
    expect(growthMb).toBeLessThan(150); // ...sem a memória acompanhar

    // Conteúdo íntegro em entradas do começo, meio e fim.
    const fd = openSync(out, 'r');
    try {
      for (const e of [entries[0]!, entries[PHOTOS >> 1]!, entries[PHOTOS - 1]!]) {
        const local = Buffer.alloc(30);
        readSync(fd, local, 0, 30, e.offset);
        const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const data = Buffer.alloc(e.size);
        readSync(fd, data, 0, e.size, start);
        expect(Buffer.compare(data, content), e.name).toBe(0);
      }
    } finally {
      closeSync(fd);
      rmSync(out, { force: true });
    }
  }, 240_000);
});
