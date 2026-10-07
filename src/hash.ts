/**
 * Returns the lowercase hex SHA-256 of the given Wasm bytes. This equals the Wasm hash
 * Stellar assigns on upload. Uses Web Crypto, so it runs on Node 20+ and in browsers.
 */
export async function hashWasm(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('Web Crypto (crypto.subtle) is not available in this runtime; cannot compute a Wasm hash.');
  }
  // Copy so the digest input is always backed by a plain ArrayBuffer, never a SharedArrayBuffer.
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes));
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
