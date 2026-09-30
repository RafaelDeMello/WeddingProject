import { describe, expect, it } from 'vitest';
import { MAX_SIDE, fitWithin } from '../src/compress';
import { slugFromPath } from '../src/slug';

describe('fitWithin', () => {
  it('reduz o lado maior para 1600 mantendo a proporção', () => {
    expect(MAX_SIDE).toBe(1600);
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1600, height: 900 });
  });

  it('não amplia imagens menores', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('rejeita dimensões inválidas', () => {
    expect(() => fitWithin(0, 100)).toThrow();
  });
});

describe('slugFromPath', () => {
  it('extrai o slug de /e/<slug>', () => {
    expect(slugFromPath('/e/a8k2x')).toBe('a8k2x');
    expect(slugFromPath('/e/a8k2x/')).toBe('a8k2x');
  });

  it('outros caminhos não têm slug', () => {
    for (const path of ['/', '/e', '/e/', '/e/a/b', '/x/a8k2x', '/e/%E0%A4%A']) {
      expect(slugFromPath(path)).toBeNull();
    }
  });
});
