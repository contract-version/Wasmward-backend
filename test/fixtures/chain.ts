import type { rpc } from '@stellar/stellar-sdk';
import type { GuardServer } from '../../src/guard.js';
import { codeKeyFor, instanceKeyFor, parsedCodeEntry, parsedEntry } from './ledger.js';

export const PASSPHRASE = 'Test SDF Network ; September 2015';

type Instance = { kind: 'wasm'; hash: string } | { kind: 'asset' };

/**
 * A scriptable stand-in for Stellar RPC. Tests set what each contract runs and whether calls fail,
 * and read back how many lookups happened.
 */
export class FakeChain implements GuardServer {
  passphrase = PASSPHRASE;
  latestLedger = 10_000;
  /** Ledgers an instance stays live past `latestLedger`. */
  ttl = 5_000;
  /** Ledgers a Wasm code entry stays live past `latestLedger`. Follows `ttl` unless set here or per hash with `setCodeTtl`. */
  codeTtl: number | undefined;
  /** When set, every `getLedgerEntries` call rejects with this error. */
  failLookups: Error | undefined;
  /** When set, `getNetwork` rejects with this error. */
  failNetwork: Error | undefined;
  /** When set, `getLedgerEntries` waits for this promise before answering. */
  gate: Promise<void> | undefined;

  networkCalls = 0;
  /** Key counts of the lookups for contract instances: one entry per poll round. */
  lookupCalls: number[] = [];
  /** Key counts of the follow-up lookups for Wasm code entries. */
  codeLookupCalls: number[] = [];

  private readonly instances = new Map<string, Instance>();
  /** Per-hash overrides: a number is that hash's TTL in ledgers (negative = already expired); null = no entry at all. */
  private readonly codeOverrides = new Map<string, number | null>();

  setWasm(contractId: string, hash: string): void {
    this.instances.set(contractId, { kind: 'wasm', hash });
  }

  setAsset(contractId: string): void {
    this.instances.set(contractId, { kind: 'asset' });
  }

  /** Sets how long the Wasm code entry for a hash stays live. A negative TTL makes it expired. */
  setCodeTtl(hash: string, ttl: number): void {
    this.codeOverrides.set(hash, ttl);
  }

  /** Makes the Wasm code entry for a hash vanish, as if it had been evicted. */
  removeCode(hash: string): void {
    this.codeOverrides.set(hash, null);
  }

  remove(contractId: string): void {
    this.instances.delete(contractId);
  }

  getNetwork = (): Promise<{ passphrase: string }> => {
    this.networkCalls += 1;
    if (this.failNetwork !== undefined) return Promise.reject(this.failNetwork);
    return Promise.resolve({ passphrase: this.passphrase });
  };

  getLedgerEntries = async (...keys: Parameters<GuardServer['getLedgerEntries']>): Promise<rpc.Api.GetLedgerEntriesResponse> => {
    if (keys.every((key) => key.type === 'contractCode')) this.codeLookupCalls.push(keys.length);
    else this.lookupCalls.push(keys.length);
    // Capture what the chain holds now, so a gated call answers with the world as it was when asked.
    const entries: rpc.Api.LedgerEntryResult[] = [];
    for (const [contractId, instance] of this.instances) {
      const wanted = instanceKeyFor(contractId).toXdr('base64');
      if (!keys.some((key) => key.toXdr('base64') === wanted)) continue;
      const spec = instance.kind === 'wasm' ? ({ type: 'wasm', hash: instance.hash } as const) : ({ type: 'asset' } as const);
      entries.push(parsedEntry(contractId, spec, this.latestLedger + this.ttl));
    }
    // Every Wasm hash in use has a code entry, live unless a test says otherwise.
    const hashes = new Set<string>();
    for (const instance of this.instances.values()) if (instance.kind === 'wasm') hashes.add(instance.hash);
    for (const hash of hashes) {
      if (!keys.some((key) => key.toXdr('base64') === codeKeyFor(hash).toXdr('base64'))) continue;
      const override = this.codeOverrides.get(hash);
      if (override === null) continue;
      entries.push(parsedCodeEntry(hash, this.latestLedger + (override ?? this.codeTtl ?? this.ttl)));
    }
    const gate = this.gate;
    if (gate !== undefined) await gate;
    if (this.failLookups !== undefined) throw this.failLookups;
    return { entries, latestLedger: this.latestLedger };
  };
}
