import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchExecutables } from '../../src/fetch.js';
import { contractIdOf, hashOf, parsedCodeEntry, parsedEntry, toRaw, type RawEntry } from '../fixtures/ledger.js';

/**
 * These tests run the real `rpc.Server` against a local HTTP server that replies with
 * wire-format JSON-RPC, so the SDK's own response parsing is part of what is tested.
 */

const LATEST = 5_000;
const A = contractIdOf(1);
const B = contractIdOf(2);
const C = contractIdOf(3);

type Reply = (request: { id: number; params: { keys: string[] } }, res: ServerResponse) => void;

let server: Server;
let reply: Reply;
let requests: { keys: string[] }[];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, id: number, result: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

beforeEach(async () => {
  requests = [];
  reply = (request, res) => json(res, request.id, { entries: [], latestLedger: LATEST });
  server = createServer((req, res) => {
    void readBody(req).then((text) => {
      const body = JSON.parse(text) as { id: number; params: { keys: string[] } };
      requests.push({ keys: body.params.keys });
      reply(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): rpc.Server {
  const { port } = server.address() as AddressInfo;
  return new rpc.Server(`http://127.0.0.1:${port}`, { allowHttp: true });
}

/**
 * Answers instance lookups with `entries`. Lookups for Wasm code entries get `codeEntries`, or by default a
 * live entry for every hash asked about.
 */
function replyWith(entries: RawEntry[], latestLedger: number = LATEST, codeEntries?: RawEntry[]): void {
  reply = (request, res) => {
    const keys = request.params.keys.map((key) => xdr.LedgerKey.fromXdr(key, 'base64'));
    if (keys.length > 0 && keys.every((key) => key.type === 'contractCode')) {
      const live = keys.map((key) =>
        key.type === 'contractCode' ? toRaw(parsedCodeEntry(Buffer.from(key.contractCode.hash.toBytes()).toString('hex'), LATEST + 100)) : never(),
      );
      json(res, request.id, { entries: codeEntries ?? live, latestLedger });
    } else {
      json(res, request.id, { entries, latestLedger });
    }
  };
}

function never(): never {
  throw new Error('unreachable');
}

describe('fetchExecutables against a replayed RPC', () => {
  it('decodes a mixed, out-of-order batch from wire-format responses', async () => {
    replyWith([
      toRaw(parsedEntry(C, { type: 'asset' }, LATEST + 20)),
      toRaw(parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 20)),
    ]);

    const result = await fetchExecutables(client(), [A, B, C], 5_000);

    // One lookup for the three instances, then one for the single Wasm hash found.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.keys).toHaveLength(3);
    expect(requests[1]?.keys).toHaveLength(1);
    expect(result.get(A)).toEqual({
      kind: 'wasm',
      wasmHash: hashOf(1),
      liveUntilLedger: LATEST + 20,
      codeLiveUntilLedger: LATEST + 100,
      latestLedger: LATEST,
    });
    expect(result.get(B)).toEqual({ kind: 'missing', latestLedger: LATEST });
    expect(result.get(C)).toEqual({ kind: 'stellar-asset', latestLedger: LATEST });
  });

  it('reads the code entry from a wire-format response and reports its own expiry', async () => {
    replyWith([toRaw(parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 900))], LATEST, [
      toRaw(parsedCodeEntry(hashOf(1), LATEST + 40)),
    ]);
    expect((await fetchExecutables(client(), [A], 5_000)).get(A)).toMatchObject({
      kind: 'wasm',
      liveUntilLedger: LATEST + 900,
      codeLiveUntilLedger: LATEST + 40,
    });
  });

  it('reports an expired code entry as archived, and an absent one too', async () => {
    const instance = [toRaw(parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 900))];
    replyWith(instance, LATEST, [toRaw(parsedCodeEntry(hashOf(1), LATEST - 3))]);
    expect((await fetchExecutables(client(), [A], 5_000)).get(A)).toEqual({
      kind: 'archived',
      entry: 'code',
      wasmHash: hashOf(1),
      liveUntilLedger: LATEST - 3,
      latestLedger: LATEST,
    });
    replyWith(instance, LATEST, []);
    expect((await fetchExecutables(client(), [A], 5_000)).get(A)).toMatchObject({ kind: 'archived', entry: 'code' });
  });

  it('reports an expired instance as archived', async () => {
    replyWith([toRaw(parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST - 10))]);
    expect((await fetchExecutables(client(), [A], 5_000)).get(A)).toEqual({
      kind: 'archived',
      liveUntilLedger: LATEST - 10,
      latestLedger: LATEST,
    });
  });

  it('returns an error for an external-reference executable on the wire', async () => {
    replyWith([toRaw(parsedEntry(A, { type: 'external' }, LATEST + 20))]);
    expect((await fetchExecutables(client(), [A], 5_000)).get(A)?.kind).toBe('error');
  });

  it('returns an error for every contract when the server answers HTTP 500', async () => {
    reply = (_request, res) => {
      res.statusCode = 500;
      res.end('internal error');
    };
    const result = await fetchExecutables(client(), [A, B], 5_000);
    expect(result.get(A)?.kind).toBe('error');
    expect(result.get(B)?.kind).toBe('error');
  });

  it('returns an error when the server sends a JSON-RPC error', async () => {
    reply = (request, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'invalid params' } }));
    };
    const result = (await fetchExecutables(client(), [A], 5_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('invalid params') });
  });

  it('returns an error when the response body is not valid', async () => {
    reply = (_request, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{ not json');
    };
    expect((await fetchExecutables(client(), [A], 5_000)).get(A)?.kind).toBe('error');
  });

  it('returns an error when the server never answers within the timeout', async () => {
    reply = () => undefined;
    const startedAt = Date.now();
    const result = await fetchExecutables(client(), [A], 150);
    expect(result.get(A)).toEqual({ kind: 'error', message: 'getLedgerEntries timed out after 150ms' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('returns an error when nothing is listening', async () => {
    const dead = new rpc.Server('http://127.0.0.1:1', { allowHttp: true });
    expect((await fetchExecutables(dead, [A], 2_000)).get(A)?.kind).toBe('error');
  });
});
