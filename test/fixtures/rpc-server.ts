import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { xdr } from '@stellar/stellar-sdk';
import type { FakeChain } from './chain.js';
import { toRaw } from './ledger.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
  });
}

export interface RunningRpc {
  url: string;
  close(): Promise<void>;
}

/** Serves a FakeChain over HTTP JSON-RPC, so a separate process can talk to it. */
export async function startRpcServer(chain: FakeChain): Promise<RunningRpc> {
  const server: Server = createServer((req, res) => {
    void readBody(req).then(async (text) => {
      const request = JSON.parse(text) as { id: number; method: string; params?: { keys?: string[] } };
      res.setHeader('content-type', 'application/json');
      try {
        if (request.method === 'getNetwork') {
          const { passphrase } = await chain.getNetwork();
          res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { passphrase, protocolVersion: 29 } }));
        } else if (request.method === 'getLedgerEntries') {
          const keys = (request.params?.keys ?? []).map((key) => xdr.LedgerKey.fromXdr(key, 'base64'));
          const result = await chain.getLedgerEntries(...keys);
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { entries: result.entries.map(toRaw), latestLedger: result.latestLedger },
            }),
          );
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }));
        }
      } catch (error) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
