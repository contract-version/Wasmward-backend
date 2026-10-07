import { Address, StrKey, xdr, type rpc } from '@stellar/stellar-sdk';

/** A valid, deterministic contract ID. Different `n` give different IDs. */
export function contractIdOf(n: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = n & 0xff;
  bytes[1] = (n >> 8) & 0xff;
  bytes[31] = 0xcc;
  return StrKey.encodeContract(bytes);
}

/** 32 bytes derived from a seed, as lowercase hex. */
export function hashOf(seed: number): string {
  return Array.from({ length: 32 }, (_, i) => ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function instanceKeyFor(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

export type ExecutableSpec =
  | { type: 'wasm'; hash: string }
  | { type: 'asset' }
  | { type: 'external' }
  /** Contract data whose value is not a contract instance. */
  | { type: 'not-instance' };

function dataFor(contractId: string, spec: ExecutableSpec): xdr.LedgerEntryData {
  let val: xdr.ScVal;
  if (spec.type === 'not-instance') {
    val = xdr.ScVal.scvU32(7);
  } else {
    let executable: xdr.ContractExecutable;
    if (spec.type === 'wasm') {
      executable = xdr.ContractExecutable.contractExecutableWasm(hexToBytes(spec.hash));
    } else if (spec.type === 'asset') {
      executable = xdr.ContractExecutable.contractExecutableStellarAsset();
    } else {
      executable = xdr.ContractExecutable.contractExecutableExternalRef(
        new xdr.ContractExecutableExternalRef({
          executableOwner: new Address(contractIdOf(999)).toScAddress(),
          tag: 'tag',
        }),
      );
    }
    val = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null }));
  }
  return new xdr.LedgerEntryDataContractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.fromXdrObject({ v: 0 }),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val,
    }),
  );
}

/** An entry in the shape `rpc.Server#getLedgerEntries` returns after parsing. */
export function parsedEntry(
  contractId: string,
  spec: ExecutableSpec,
  liveUntilLedgerSeq: number | undefined,
): rpc.Api.LedgerEntryResult {
  const entry: rpc.Api.LedgerEntryResult = {
    lastModifiedLedgerSeq: 100,
    key: instanceKeyFor(contractId),
    val: dataFor(contractId, spec),
  };
  if (liveUntilLedgerSeq !== undefined) entry.liveUntilLedgerSeq = liveUntilLedgerSeq;
  return entry;
}

/** An entry whose value is not contract data at all (a TTL entry). */
export function nonContractEntry(contractId: string): rpc.Api.LedgerEntryResult {
  return {
    lastModifiedLedgerSeq: 100,
    key: instanceKeyFor(contractId),
    val: new xdr.LedgerEntryDataTtl(
      new xdr.TtlEntry({ keyHash: new Uint8Array(32), liveUntilLedgerSeq: 5 }),
    ),
  };
}

export interface RawEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq?: number;
}

/** The JSON shape Stellar RPC sends on the wire for one entry. */
export function toRaw(entry: rpc.Api.LedgerEntryResult): RawEntry {
  const raw: RawEntry = {
    key: entry.key.toXdr('base64'),
    xdr: entry.val.toXdr('base64'),
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? 0,
  };
  if (entry.liveUntilLedgerSeq !== undefined) raw.liveUntilLedgerSeq = entry.liveUntilLedgerSeq;
  return raw;
}
