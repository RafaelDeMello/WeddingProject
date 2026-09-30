// crypto.randomUUID só existe a partir do iOS 15.4; antes disso, getRandomValues (iOS 11+).

interface CryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
  randomUUID?: () => string;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** UUID v4 a partir de 16 bytes aleatórios (RFC 9562: versão 4, variante 10xx). */
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('UUID precisa de 16 bytes.');
  const b = Uint8Array.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => HEX[x]!);
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

export function uuidv4(cryptoImpl: CryptoLike = globalThis.crypto): string {
  if (typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
  return uuidFromBytes(cryptoImpl.getRandomValues(new Uint8Array(16)));
}
