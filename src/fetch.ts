import { Address, xdr, type rpc } from '@stellar/stellar-sdk';
import type { LiveExecutable } from './types.js';

/** Stellar RPC accepts at most this many keys in one getLedgerEntries request. */
export const MAX_KEYS_PER_REQUEST = 200;

/** The one RPC method this module needs. `rpc.Server` satisfies it. */
export interface LedgerEntriesSource {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
}

interface Requested {
  contractId: string;
  key: xdr.LedgerKey;
  keyXdr: string;
}

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

/** Readable text for anything a call may throw, including the plain objects the RPC client rejects with. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function codeKey(wasmHash: string): xdr.LedgerKey {
  const bytes = Uint8Array.from(wasmHash.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: bytes }));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Rejects with `<label> timed out after <n>ms` if `work` has not settled in time. */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Turns one returned ledger entry into a result. Never guesses: anything unexpected is an error. */
function decodeEntry(entry: rpc.Api.LedgerEntryResult, latestLedger: number): LiveExecutable {
  const data = entry.val;
  if (data.type !== 'contractData') {
    return { kind: 'error', message: `ledger entry is ${data.type}, not contract data` };
  }
  const value = data.contractData.val;
  if (value.type !== 'scvContractInstance') {
    return { kind: 'error', message: `contract data value is ${value.type}, not a contract instance` };
  }
  const executable = value.instance.executable;
  const liveUntilLedger = entry.liveUntilLedgerSeq;

  switch (executable.type) {
    case 'contractExecutableWasm': {
      if (liveUntilLedger === undefined) {
        return { kind: 'error', message: 'RPC did not return liveUntilLedgerSeq, so archival cannot be ruled out' };
      }
      if (liveUntilLedger < latestLedger) {
        return { kind: 'archived', liveUntilLedger, latestLedger };
      }
      // The Wasm code is a separate ledger entry with its own lifetime; `attachCodeLifetimes` fills it in.
      return {
        kind: 'wasm',
        wasmHash: toHex(executable.wasmHash.toBytes()),
        liveUntilLedger,
        codeLiveUntilLedger: liveUntilLedger,
        latestLedger,
      };
    }
    case 'contractExecutableStellarAsset':
      if (liveUntilLedger !== undefined && liveUntilLedger < latestLedger) {
        return { kind: 'archived', liveUntilLedger, latestLedger };
      }
      return { kind: 'stellar-asset', latestLedger };
    case 'contractExecutableExternalRef':
      return { kind: 'error', message: 'contract uses an external-reference executable, which Wasmward cannot verify' };
    default: {
      const unknown: never = executable;
      return { kind: 'error', message: `unrecognized executable variant: ${String(unknown)}` };
    }
  }
}

async function fetchChunk(
  source: LedgerEntriesSource,
  chunk: Requested[],
  timeoutMs: number,
  results: Map<string, LiveExecutable>,
): Promise<void> {
  let response: rpc.Api.GetLedgerEntriesResponse;
  try {
    response = await withTimeout(source.getLedgerEntries(...chunk.map((item) => item.key)), timeoutMs, 'getLedgerEntries');
  } catch (error) {
    const failure: LiveExecutable = { kind: 'error', message: messageOf(error) };
    for (const item of chunk) results.set(item.contractId, failure);
    return;
  }

  const latestLedger = response.latestLedger;
  if (typeof latestLedger !== 'number' || !Number.isFinite(latestLedger)) {
    const failure: LiveExecutable = { kind: 'error', message: 'RPC response did not include a valid latestLedger' };
    for (const item of chunk) results.set(item.contractId, failure);
    return;
  }

  // Match entries to requests by key XDR, never by array position.
  const byKey = new Map(chunk.map((item) => [item.keyXdr, item.contractId]));
  for (const entry of response.entries ?? []) {
    let contractId: string | undefined;
    let decoded: LiveExecutable;
    try {
      contractId = byKey.get(entry.key.toXdr('base64'));
      if (contractId === undefined || results.has(contractId)) continue;
      decoded = decodeEntry(entry, latestLedger);
    } catch (error) {
      if (contractId === undefined) continue;
      decoded = { kind: 'error', message: `could not decode ledger entry: ${messageOf(error)}` };
    }
    results.set(contractId, decoded);
  }

  for (const item of chunk) {
    if (!results.has(item.contractId)) results.set(item.contractId, { kind: 'missing', latestLedger });
  }
}

/**
 * Second lookup: for every contract running Wasm, reads the ledger entry that holds that Wasm (once per
 * distinct hash). A live instance whose code entry has expired still looks healthy but every call fails, so
 * an expired or missing code entry makes the contract `archived`. The code bytes themselves are never read.
 */
async function attachCodeLifetimes(
  source: LedgerEntriesSource,
  timeoutMs: number,
  results: Map<string, LiveExecutable>,
): Promise<void> {
  const byHash = new Map<string, string[]>();
  for (const [contractId, result] of results) {
    if (result.kind !== 'wasm') continue;
    byHash.set(result.wasmHash, [...(byHash.get(result.wasmHash) ?? []), contractId]);
  }
  const hashes = [...byHash.keys()];
  const chunks: string[][] = [];
  for (let start = 0; start < hashes.length; start += MAX_KEYS_PER_REQUEST) {
    chunks.push(hashes.slice(start, start + MAX_KEYS_PER_REQUEST));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      const fail = (message: string): void => {
        for (const hash of chunk) for (const id of byHash.get(hash) ?? []) results.set(id, { kind: 'error', message });
      };
      const keys = new Map(chunk.map((hash) => [codeKey(hash).toXdr('base64'), hash]));
      let response: rpc.Api.GetLedgerEntriesResponse;
      try {
        response = await withTimeout(
          source.getLedgerEntries(...chunk.map((hash) => codeKey(hash))),
          timeoutMs,
          'getLedgerEntries (code)',
        );
      } catch (error) {
        fail(`could not read the Wasm code entry: ${messageOf(error)}`);
        return;
      }
      const latestLedger = response.latestLedger;
      if (typeof latestLedger !== 'number' || !Number.isFinite(latestLedger)) {
        fail('RPC response for the Wasm code entry did not include a valid latestLedger');
        return;
      }

      // Match by key XDR, never by position. An entry that is absent from the answer is a missing entry.
      const liveUntil = new Map<string, number | undefined>();
      for (const entry of response.entries ?? []) {
        try {
          const hash = keys.get(entry.key.toXdr('base64'));
          if (hash !== undefined && !liveUntil.has(hash)) liveUntil.set(hash, entry.liveUntilLedgerSeq);
        } catch {
          // An undecodable entry counts as absent, which blocks writes.
        }
      }
      for (const hash of chunk) {
        for (const contractId of byHash.get(hash) ?? []) {
          const instance = results.get(contractId);
          if (instance?.kind !== 'wasm') continue;
          const end = liveUntil.get(hash);
          if (!liveUntil.has(hash) || (end !== undefined && end < latestLedger)) {
            results.set(contractId, { kind: 'archived', entry: 'code', wasmHash: hash, latestLedger, ...(end === undefined ? {} : { liveUntilLedger: end }) });
          } else if (end === undefined) {
            results.set(contractId, { kind: 'error', message: 'RPC did not return liveUntilLedgerSeq for the Wasm code entry, so its expiry cannot be ruled out' });
          } else {
            results.set(contractId, { ...instance, codeLiveUntilLedger: end });
          }
        }
      }
    }),
  );
}

/**
 * Looks up what code each contract instance is running, using as few RPC calls as the
 * per-request key limit allows. Every requested contract ID appears in the returned map.
 * Failures (network, timeout, malformed data) come back as `{ kind: 'error' }` rather than throwing.
 */
export async function fetchExecutables(
  source: LedgerEntriesSource,
  contractIds: readonly string[],
  timeoutMs: number,
): Promise<Map<string, LiveExecutable>> {
  const results = new Map<string, LiveExecutable>();
  const requested: Requested[] = [];

  for (const contractId of new Set(contractIds)) {
    try {
      const key = instanceKey(contractId);
      requested.push({ contractId, key, keyXdr: key.toXdr('base64') });
    } catch (error) {
      results.set(contractId, { kind: 'error', message: `invalid contract ID: ${messageOf(error)}` });
    }
  }

  const chunks: Requested[][] = [];
  for (let start = 0; start < requested.length; start += MAX_KEYS_PER_REQUEST) {
    chunks.push(requested.slice(start, start + MAX_KEYS_PER_REQUEST));
  }
  await Promise.all(chunks.map((chunk) => fetchChunk(source, chunk, timeoutMs, results)));
  await attachCodeLifetimes(source, timeoutMs, results);

  return results;
}
