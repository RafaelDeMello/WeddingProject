import { describe, expect, it } from 'vitest';
import { KeyedMutex, Semaphore } from '../src/concurrency.js';
import { createPrisma, withConnectionLimit } from '../src/db.js';
import { createTestContext } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializa tarefas da mesma chave, na ordem de chegada', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      (async () => {
        log.push(`inicio ${name}`);
        await sleep(ms);
        log.push(`fim ${name}`);
        return name;
      })();
    const results = await Promise.all([mutex.run('k', task('a', 30)), mutex.run('k', task('b', 5)), mutex.run('k', task('c', 1))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['inicio a', 'fim a', 'inicio b', 'fim b', 'inicio c', 'fim c']);
  });

  it('chaves diferentes rodam em paralelo', async () => {
    const mutex = new KeyedMutex();
    let running = 0;
    let peak = 0;
    const task = () => async () => {
      peak = Math.max(peak, ++running);
      await sleep(20);
      running--;
    };
    await Promise.all(['a', 'b', 'c'].map((k) => mutex.run(k, task())));
    expect(peak).toBe(3);
  });

  it('erro numa tarefa não trava a fila e o mapa é limpo no fim', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run('k', async () => {
      throw new Error('falhou');
    });
    const next = mutex.run('k', async () => 'ok');
    await expect(failing).rejects.toThrow('falhou');
    await expect(next).resolves.toBe('ok');
    expect(mutex.size).toBe(0);
  });
});

describe('Semaphore', () => {
  it('nunca passa do máximo de tarefas simultâneas e executa todas', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        semaphore.run(async () => {
          peak = Math.max(peak, ++running);
          await sleep(10);
          running--;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done).toHaveLength(8);
  });

  it('libera a vaga quando a tarefa falha', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('connection_limit do SQLite', () => {
  it.each([
    ['file:/data/db/app.db', 'file:/data/db/app.db?connection_limit=1'],
    ['file:C:/dev/x/app.db', 'file:C:/dev/x/app.db?connection_limit=1'],
    ['file:/data/app.db?socket_timeout=5', 'file:/data/app.db?socket_timeout=5&connection_limit=1'],
    ['file:/data/app.db?connection_limit=1', 'file:/data/app.db?connection_limit=1'],
    ['file:/data/app.db?connection_limit=4', 'file:/data/app.db?connection_limit=4'],
  ])('withConnectionLimit(%s)', (input, expected) => {
    expect(withConnectionLimit(input)).toBe(expected);
  });

  it('o cliente funciona com a URL ajustada, inclusive transação interativa', async () => {
    const ctx = await createTestContext();
    try {
      const guest = await ctx.prisma.$transaction(async (tx) => {
        const g = await tx.guest.create({ data: { name: 'Ana' } });
        return tx.guest.findUniqueOrThrow({ where: { id: g.id } });
      });
      expect(guest.name).toBe('Ana');
      const other = createPrisma(ctx.env.DATABASE_URL);
      expect(await other.guest.count()).toBe(1);
      await other.$disconnect();
    } finally {
      await ctx.cleanup();
    }
  });
});
