import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchExecutables } from '../../src/fetch.js';
import { createVersionGuard } from '../../src/guard.js';
import type { WasmwardConfigInput } from '../../src/types.js';

/**
 * Replays responses recorded from Stellar testnet (test/fixtures/recorded/testnet-v1.json): the
 * instance entry and the Wasm code entry of the deployed v1 fixture contract, exactly as the RPC returned them.
 */
interface Recording {
  recordedAt: string;
  contractId: string;
  expectedWasmHash: string;
  getLedgerEntries: { result: { entries: { liveUntilLedgerSeq: number }[]; latestLedger: number } };
  getCodeEntries: { result: { entries: { liveUntilLedgerSeq: number }[]; latestLedger: number } };
  getNetwork: { result: { passphrase: string } };
}

const recording = JSON.parse(
  readFileSync(new URL('../fixtures/recorded/testnet-v1.json', import.meta.url), 'utf8'),
) as Recording;

let server: Server;
let url: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((text) => {
      const request = JSON.parse(text) as { id: number; method: string; params?: { keys?: string[] } };
      // The guard asks for the instance first, then for the Wasm code entry; answer each with its recording.
      const asksForCode = (request.params?.keys ?? []).some((key) => xdr.LedgerKey.fromXdr(key, 'base64').type === 'contractCode');
      const reply =
        request.method === 'getNetwork'
          ? (recording.getNetwork as object)
          : request.method === 'getLedgerEntries'
            ? ((asksForCode ? recording.getCodeEntries : recording.getLedgerEntries) as object)
            : { error: { code: -32601, message: 'method not found' } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...reply, jsonrpc: '2.0', id: request.id }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function configFor(hashes: string[]): WasmwardConfigInput {
  return {
    version: 1,
    network: { rpcUrl: url, passphrase: recording.getNetwork.result.passphrase },
    pollIntervalMs: 5_000,
    maxStalenessMs: 20_000,
    contracts: { vault: { contractId: recording.contractId, supported: hashes.map((wasmHash) => ({ wasmHash })) } },
  };
}

describe('responses recorded from testnet', () => {
  it('decodes the real instance entry to the Wasm hash the fixture was deployed with', async () => {
    const client = new rpc.Server(url, { allowHttp: true });
    const result = (await fetchExecutables(client, [recording.contractId], 5_000)).get(recording.contractId);
    expect(result).toEqual({
      kind: 'wasm',
      wasmHash: recording.expectedWasmHash,
      liveUntilLedger: recording.getLedgerEntries.result.entries[0]?.liveUntilLedgerSeq,
      codeLiveUntilLedger: recording.getCodeEntries.result.entries[0]?.liveUntilLedgerSeq,
      latestLedger: recording.getLedgerEntries.result.latestLedger,
    });
  });

  it('reads the real Wasm code entry, which has its own lifetime', () => {
    const code = recording.getCodeEntries.result.entries[0]?.liveUntilLedgerSeq;
    const instance = recording.getLedgerEntries.result.entries[0]?.liveUntilLedgerSeq;
    expect(code).toBeGreaterThan(recording.getCodeEntries.result.latestLedger);
    // They were extended separately, so the recorded lifetimes need not match; both must be present.
    expect(instance).toBeGreaterThan(recording.getLedgerEntries.result.latestLedger);
  });

  it('reports a contract id the RPC returned nothing for as missing', async () => {
    const client = new rpc.Server(url, { allowHttp: true });
    // The recorded response holds one entry, for the fixture contract only.
    const other = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const result = (await fetchExecutables(client, [other], 5_000)).get(other);
    expect(result).toEqual({ kind: 'missing', latestLedger: recording.getLedgerEntries.result.latestLedger });
  });

  it('lets the guard allow writes when the recorded hash is supported', async () => {
    const guard = createVersionGuard(configFor([recording.expectedWasmHash]));
    await guard.start();
    expect(guard.status()['vault']).toMatchObject({ status: 'supported', liveWasmHash: recording.expectedWasmHash });
    expect(() => guard.assertWritable('vault')).not.toThrow();
    await guard.stop();
  });

  it('lets the guard block writes when the recorded hash is not supported', async () => {
    const guard = createVersionGuard(configFor(['00'.repeat(32)]));
    await guard.start();
    expect(guard.status()['vault']?.status).toBe('unsupported');
    expect(() => guard.assertWritable('vault')).toThrow(/is not in the supported list/);
    await guard.stop();
  });
});
