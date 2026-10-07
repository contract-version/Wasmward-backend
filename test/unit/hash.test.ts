import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashWasm } from '../../src/hash.js';

const ABC_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('hashWasm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['empty input', new Uint8Array(0), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['the text abc', new TextEncoder().encode('abc'), ABC_HASH],
    [
      'a bare Wasm header',
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476',
    ],
    ['1 MiB of zeros', new Uint8Array(1 << 20), '30e14955ebf1352266dc2ff8067e68104607e750abb9d3b36582b8af909fcb58'],
  ])('matches the known SHA-256 vector for %s', async (_name, bytes, expected) => {
    expect(await hashWasm(bytes)).toBe(expected);
  });

  it('returns 64 lowercase hex characters', async () => {
    expect(await hashWasm(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes only the visible window of a subarray view', async () => {
    const backing = new TextEncoder().encode('xxabcxx');
    expect(await hashWasm(backing.subarray(2, 5))).toBe(ABC_HASH);
  });

  it('does not modify its input', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    await hashWasm(bytes);
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
  });

  it('fails clearly when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    await expect(hashWasm(new Uint8Array(1))).rejects.toThrow(/Web Crypto/);
  });
});
