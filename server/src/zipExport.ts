import { stat } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { ZipArchive } from 'archiver';
import type { Logger } from 'pino';
import { resolveDataFile } from './gallery.js';

export const HIDDEN_FOLDER = '_ocultas';
export const MISSING_REPORT = '_faltando.txt';

/** Fotos lidas do banco por vez (paginação por chave: nunca a tabela inteira em memória). */
const DB_BATCH = 500;
/** Entradas já enfileiradas no archiver e ainda não gravadas: limita a fila mesmo com dezenas de milhares de fotos. */
const MAX_PENDING_ENTRIES = 100;

/** Nome seguro para pasta: sem acentos, minúsculo, só [a-z0-9-], até 40 caracteres. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'convidado';
}

export const guestFolder = (guest: { id: string; name: string }) => `${slugify(guest.name)}-${guest.id.slice(0, 8)}`;

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const stamp = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const wallClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const parts = (format: Intl.DateTimeFormat, date: Date) =>
  Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));

/** HHmmss no horário do evento (America/Sao_Paulo). */
export function timeOfDay(date: Date): string {
  const p = parts(clock, date);
  return `${p.hour}${p.minute}${p.second}`;
}

/**
 * O ZIP guarda data e hora SEM fuso (campos de relógio) e o archiver escreve os campos UTC da data recebida.
 * Devolve a hora de Brasília "como se fosse UTC" para o extrator mostrar a hora certa (20:12, não 23:12).
 */
export function zipTimestamp(date: Date): Date {
  const p = parts(wallClock, date);
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)));
}

/** AAAAMMDD-HHmm no horário do evento, para o nome do arquivo baixado. */
export function fileStamp(date: Date): string {
  const p = parts(stamp, date);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

/** <nome>-<guestId curto>/<HHmmss>-<photoId>.jpg; ocultas (ou apagadas pelo dono) em _ocultas/ com a mesma estrutura. */
export function entryName(
  photo: { id: string; createdAt: Date; hiddenAt: Date | null },
  guest: { id: string; name: string },
): string {
  const name = `${guestFolder(guest)}/${timeOfDay(photo.createdAt)}-${photo.id}.jpg`;
  return photo.hiddenAt ? `${HIDDEN_FOLDER}/${name}` : name;
}

export interface ExportSummary {
  files: number;
  missing: number;
  bytes: number;
}

/**
 * Escreve um ZIP com todas as fotos em `output`, em streaming: lê as fotos do banco em lotes, enfileira
 * poucos arquivos por vez (cada um é aberto só quando chega a sua vez) e respeita o backpressure de
 * `output`. JPEG não comprime, então as entradas são gravadas sem compressão (STORE).
 * Se `signal` abortar (cliente desconectou), interrompe o archiver e retorna.
 */
export async function streamPhotosZip(opts: {
  prisma: PrismaClient;
  dataDir: string;
  output: Writable;
  signal: AbortSignal;
  logger: Logger;
}): Promise<ExportSummary> {
  const { prisma, dataDir, output, signal, logger } = opts;
  // store: true vale para todas as entradas (inclusive as de archive.file).
  const archive = new ZipArchive({ store: true });
  const summary: ExportSummary = { files: 0, missing: 0, bytes: 0 };
  const missing: string[] = [];

  let processed = 0;
  let waiter: (() => void) | null = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  archive.on('entry', () => {
    processed++;
    wake();
  });
  archive.on('warning', (err) => logger.warn({ err }, 'aviso do archiver durante a exportação'));
  signal.addEventListener('abort', wake);

  const finished = new Promise<void>((resolve, reject) => {
    archive.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
    output.once('close', resolve);
  });
  archive.pipe(output);

  const waitForRoom = async () => {
    while (!signal.aborted && summary.files - processed >= MAX_PENDING_ENTRIES) {
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  };

  const fetchBatch = (after: string | null) =>
    prisma.photo.findMany({
      where: after === null ? {} : { id: { gt: after } },
      orderBy: { id: 'asc' },
      take: DB_BATCH,
      include: { guest: { select: { id: true, name: true } } },
    });

  const produce = async () => {
    let lastId: string | null = null;
    for (;;) {
      if (signal.aborted) return;
      const rows: Awaited<ReturnType<typeof fetchBatch>> = await fetchBatch(lastId);
      if (rows.length === 0) return;
      lastId = rows[rows.length - 1]!.id;

      for (const photo of rows) {
        if (signal.aborted) return;
        const absolute = resolveDataFile(dataDir, photo.filePath);
        const stats = absolute ? await stat(absolute).catch(() => null) : null;
        if (!absolute || !stats?.isFile()) {
          missing.push(photo.id);
          summary.missing++;
          logger.warn({ photoId: photo.id }, 'arquivo da foto não encontrado; fora do ZIP');
          continue;
        }
        await waitForRoom();
        if (signal.aborted) return;
        // `stats` evita que o archiver faça outro stat; `date` faz o ZIP guardar a hora (de Brasília) da foto.
        archive.file(absolute, {
          name: entryName(photo, photo.guest),
          stats,
          date: zipTimestamp(photo.createdAt),
        });
        summary.files++;
        summary.bytes += stats.size;
      }
    }
  };

  try {
    await produce();
    if (signal.aborted) {
      archive.abort();
      return summary;
    }
    if (missing.length > 0) {
      const report = `Fotos registradas no banco cujo arquivo não foi encontrado no disco (${missing.length}):\n${missing.join('\n')}\n`;
      archive.append(Buffer.from(report, 'utf8'), { name: MISSING_REPORT });
    }
    void archive.finalize().catch(() => undefined); // erros chegam por archive.on('error')
    await finished;
    return summary;
  } catch (err) {
    archive.abort();
    throw err;
  } finally {
    signal.removeEventListener('abort', wake);
  }
}
