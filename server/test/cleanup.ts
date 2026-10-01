import { rmSync } from 'node:fs';

/**
 * Apaga uma pasta temporária de teste, em melhor esforço.
 *
 * No Windows o SQLite/Prisma às vezes demora a soltar os arquivos do banco e o `rmSync` falha com EPERM
 * (intermitente, só sob carga, sem relação com o produto). Tenta algumas vezes e, se ainda assim não
 * conseguir, desiste em silêncio: sobra uma pasta no %TEMP% do sistema, o que não invalida teste algum.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // melhor esforço
  }
}
