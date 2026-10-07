import type { rpc } from '@stellar/stellar-sdk';
import type { GuardServer } from '../../src/guard.js';
import { instanceKeyFor, parsedEntry } from './ledger.js';

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
  /** When set, every `getLedgerEntries` call rejects with this error. */
  failLookups: Error | undefined;
  /** When set, `getNetwork` rejects with this error. */
  failNetwork: Error | undefined;
  /** When set, `getLedgerEntries` waits for this promise before answering. */
  gate: Promise<void> | undefined;

  networkCalls = 0;
  lookupCalls: number[] = [];

  private readonly instances = new Map<string, Instance>();

  setWasm(contractId: string, hash: string): void {
    this.instances.set(contractId, { kind: 'wasm', hash });
  }

  setAsset(contractId: string): void {
    this.instances.set(contractId, { kind: 'asset' });
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
    this.lookupCalls.push(keys.length);
    // Capture what the chain holds now, so a gated call answers with the world as it was when asked.
    const entries: rpc.Api.LedgerEntryResult[] = [];
    for (const [contractId, instance] of this.instances) {
      const wanted = instanceKeyFor(contractId).toXdr('base64');
      if (!keys.some((key) => key.toXdr('base64') === wanted)) continue;
      const spec = instance.kind === 'wasm' ? ({ type: 'wasm', hash: instance.hash } as const) : ({ type: 'asset' } as const);
      entries.push(parsedEntry(contractId, spec, this.latestLedger + this.ttl));
    }
    const gate = this.gate;
    if (gate !== undefined) await gate;
    if (this.failLookups !== undefined) throw this.failLookups;
    return { entries, latestLedger: this.latestLedger };
  };
}
