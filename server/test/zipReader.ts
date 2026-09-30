import { closeSync, openSync, readSync, fstatSync } from 'node:fs';

// Leitor mínimo de ZIP (só o necessário para os testes): diretório central e entradas STORE.
// Não suporta ZIP64 — os testes ficam abaixo de 65535 entradas e 4 GB.

export interface ZipEntry {
  name: string;
  method: number;
  size: number;
  compressedSize: number;
  offset: number;
  /** Campos DOS de data/hora gravados no ZIP (sem fuso). */
  dos: { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function parseCentralDirectory(cd: Buffer, total: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let i = 0; i < total; i++) {
    if (cd.readUInt32LE(pos) !== CD_SIG) throw new Error(`entrada ${i}: assinatura inválida do diretório central`);
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    const time = cd.readUInt16LE(pos + 12);
    const date = cd.readUInt16LE(pos + 14);
    entries.push({
      dos: {
        year: (date >> 9) + 1980,
        month: (date >> 5) & 15,
        day: date & 31,
        hour: time >> 11,
        minute: (time >> 5) & 63,
        second: (time & 31) * 2,
      },
      method: cd.readUInt16LE(pos + 10),
      compressedSize: cd.readUInt32LE(pos + 20),
      size: cd.readUInt32LE(pos + 24),
      offset: cd.readUInt32LE(pos + 42),
      name: cd.subarray(pos + 46, pos + 46 + nameLength).toString('utf8'),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(tail: Buffer): { total: number; cdSize: number; cdOffset: number } {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      return {
        total: tail.readUInt16LE(i + 10),
        cdSize: tail.readUInt32LE(i + 12),
        cdOffset: tail.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error('fim do diretório central (EOCD) não encontrado: ZIP incompleto');
}

/** ZIP inteiro em memória. */
export function listZip(zip: Buffer): ZipEntry[] {
  const { total, cdSize, cdOffset } = findEocd(zip.subarray(Math.max(0, zip.length - 70_000)));
  return parseCentralDirectory(zip.subarray(cdOffset, cdOffset + cdSize), total);
}

/** Conteúdo de uma entrada STORE. */
export function readEntry(zip: Buffer, entry: ZipEntry): Buffer {
  if (zip.readUInt32LE(entry.offset) !== LOCAL_SIG) throw new Error(`${entry.name}: cabeçalho local inválido`);
  if (entry.method !== 0) throw new Error(`${entry.name}: esperava STORE, veio método ${entry.method}`);
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  return zip.subarray(start, start + entry.compressedSize);
}

/** ZIP em arquivo: lê só o fim e o diretório central (não carrega o arquivo inteiro). */
export function listZipFile(file: string): { entries: ZipEntry[]; fileSize: number } {
  const fd = openSync(file, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const tailLength = Math.min(fileSize, 70_000);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, fileSize - tailLength);
    const { total, cdSize, cdOffset } = findEocd(tail);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    return { entries: parseCentralDirectory(cd, total), fileSize };
  } finally {
    closeSync(fd);
  }
}
