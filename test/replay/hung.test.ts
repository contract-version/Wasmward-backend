import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rpc } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ABORT_SLACK_MS, createRpcClient } from '../../src/endpoints.js';
import { fetchExecutables } from '../../src/fetch.js';
import { contractIdOf } from '../fixtures/ledger.js';

/**
 * A server that accepts requests and never answers, counting those still in flight. Giving up on a request
 * is not the same as cancelling it: these tests check that the request is really abandoned, which closes
 * its connection. (The HTTP client may open an idle pooled connection afterwards; that is not a request.)
 */
const TIMEOUT = 300;
const ID = contractIdOf(1);

interface Hung {
  url: string;
  /** Connections that have sent a request and are still waiting for an answer. */
  inFlight: () => number;
  close: () => Promise<void>;
}

const running: Hung[] = [];

async function hungServer(): Promise<Hung> {
  let inFlight = 0;
  const server: Server = createServer((req) => {
    // Never responds. The request is in flight until its connection goes away.
    inFlight += 1;
    req.socket.on('close', () => {
      inFlight -= 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hung: Hung = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    inFlight: () => inFlight,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(hung);
  return hung;
}

afterEach(async () => {
  for (const hung of running.splice(0)) await hung.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

describe('a hung RPC', () => {
  it('has its request abandoned by the client once it has had its time', async () => {
    const hung = await hungServer();
    const client = createRpcClient(hung.url, TIMEOUT);

    const result = (await fetchExecutables(client, [ID], TIMEOUT)).get(ID);
    // The lookup reports its own, clear timeout, not a transport error.
    expect(result).toEqual({ kind: 'error', message: `getLedgerEntries timed out after ${TIMEOUT}ms` });
    expect(hung.inFlight()).toBe(1); // abandoned, but the request is still in flight for the moment

    // ...and then the client cancels it, freeing the connection.
    expect(await waitUntil(() => hung.inFlight() === 0, CLIENT_ABORT_SLACK_MS + 2_000)).toBe(true);
  });

  it('control: the SDK client alone never abandons the request, which is why the factory sets a timeout', async () => {
    const hung = await hungServer();
    const bare = new rpc.Server(hung.url, { allowHttp: true, timeout: TIMEOUT });
    await fetchExecutables(bare, [ID], TIMEOUT);
    // Wait as long as the fixed client needs. Its `timeout` option is not read by this SDK version.
    await sleep(CLIENT_ABORT_SLACK_MS + 1_500);
    expect(hung.inFlight()).toBe(1);
  });

  it('abandons a network check too', async () => {
    const hung = await hungServer();
    const client = createRpcClient(hung.url, TIMEOUT);
    const check = client.getNetwork().catch((error: unknown) => error);
    expect(await waitUntil(() => hung.inFlight() === 1, 2_000)).toBe(true);
    await check;
    expect(await waitUntil(() => hung.inFlight() === 0, CLIENT_ABORT_SLACK_MS + 2_000)).toBe(true);
  });

  it('does not cut off a request that is merely slow, only one past its time', async () => {
    let answered = false;
    const server = createServer((req, res) => {
      setTimeout(() => {
        answered = true;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { passphrase: 'Test', protocolVersion: 29 } }));
      }, 200);
      req.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const network = await createRpcClient(url, TIMEOUT).getNetwork();
      expect(answered).toBe(true);
      expect(network.passphrase).toBe('Test');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('allows plain http only for the URL schemes the config allows, whatever their case', () => {
    expect(() => createRpcClient('HTTP://127.0.0.1:9', TIMEOUT)).not.toThrow();
    expect(() => createRpcClient('http://127.0.0.1:9', TIMEOUT)).not.toThrow();
    expect(() => createRpcClient('https://rpc.example.org', TIMEOUT)).not.toThrow();
    expect(() => createRpcClient('http://rpc.example.org', TIMEOUT)).not.toThrow(); // the config, not this, rejects it
  });
});
