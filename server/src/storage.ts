import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataPaths } from './db.js';

export type StatFs = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export const defaultStatFs: StatFs = (dir) => statfs(dir);

/** Espaço livre para usuários comuns (bavail × bsize), em MB. */
export async function freeDiskMb(statFs: StatFs, dir: string): Promise<number> {
  const s = await statFs(dir);
  return Number((BigInt(s.bavail) * BigInt(s.bsize)) / (1024n * 1024n));
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** AAAA-MM-DD no fuso do evento. */
export const dayFolder = (date: Date) => dayFormat.format(date);

export interface StoredFiles {
  /** Caminhos relativos a DATA_DIR, com barras normais (o que vai para o banco). */
  filePath: string;
  thumbPath: string;
}

/**
 * Grava arquivos em tmp/ e move com rename atômico para o destino final. Guarda tudo o que
 * já criou para que `discard()` não deixe órfãos se algo falhar depois (cota, insert, exceção).
 */
export class PhotoFiles {
  private created = new Set<string>();
  private readonly dirs: ReturnType<typeof dataPaths>;

  constructor(private readonly dataDir: string) {
    this.dirs = dataPaths(dataDir);
  }

  private async put(buffer: Buffer, finalAbs: string): Promise<void> {
    const tmpAbs = path.join(this.dirs.tmp, `${randomUUID()}.part`);
    this.created.add(tmpAbs);
    await writeFile(tmpAbs, buffer);
    this.created.add(finalAbs);
    await rename(tmpAbs, finalAbs);
    this.created.delete(tmpAbs);
  }

  async store(photoId: string, day: string, photo: Buffer, thumb: Buffer): Promise<StoredFiles> {
    const filePath = `photos/${day}/${photoId}.jpg`;
    const thumbPath = `thumbs/${photoId}.jpg`;
    await mkdir(path.join(this.dirs.photos, day), { recursive: true });
    await this.put(photo, path.join(this.dataDir, filePath));
    await this.put(thumb, path.join(this.dataDir, thumbPath));
    return { filePath, thumbPath };
  }

  /** Apaga tudo o que esta instância criou (tmp e destino final). Seguro chamar mais de uma vez. */
  async discard(): Promise<void> {
    const all = [...this.created];
    this.created.clear();
    await Promise.all(all.map((file) => rm(file, { force: true }).catch(() => undefined)));
  }

  /** Foto registrada no banco: os arquivos passam a valer. */
  commit(): void {
    this.created.clear();
  }
}

/** No boot: o que sobrou em tmp/ de um crash não serve mais. */
export async function cleanTmp(dataDir: string): Promise<void> {
  const tmp = dataPaths(dataDir).tmp;
  for (const name of await readdir(tmp)) await rm(path.join(tmp, name), { recursive: true, force: true });
}
