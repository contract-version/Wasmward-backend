import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk';

/**
 * The fixture contract lives in the Wasmward-contract repository. Its `scripts/deploy.sh` deploys it to
 * testnet and writes `testnet.json`; this file reads that. Point `WASMWARD_FIXTURE_DIR` at a checkout
 * if it is not next to this repository.
 */
export interface TestnetFixture {
  rpcUrl: string;
  passphrase: string;
  contractId: string;
  admin: string;
  v1: { wasmHash: string; file: string };
  v2: { wasmHash: string; file: string };
}

export interface FixtureEnvironment {
  dir: string;
  fixture: TestnetFixture;
  secret: string;
}

function fixtureDir(): string {
  const fromEnv = process.env['WASMWARD_FIXTURE_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return fileURLToPath(new URL('../../../Wasmward-contract', import.meta.url));
}

/** Reads one KEY=value line from a dotenv-style file, without loading the rest of it. */
function readDotenvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] === key) return match[2]?.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** Returns the fixture environment, or the reason there is none. */
export function loadFixtureEnvironment(): { env: FixtureEnvironment } | { reason: string } {
  const dir = fixtureDir();
  const file = resolve(dir, 'testnet.json');
  if (!existsSync(file)) {
    return { reason: `${file} not found. Run scripts/deploy.sh in the Wasmward-contract repository first.` };
  }
  const secret = process.env['FIXTURE_SECRET'] || readDotenvValue(resolve(dir, '.env'), 'FIXTURE_SECRET');
  if (secret === undefined || secret === '') {
    return { reason: 'FIXTURE_SECRET is not set and was not found in the contract repository .env.' };
  }
  return { env: { dir, fixture: JSON.parse(readFileSync(file, 'utf8')) as TestnetFixture, secret } };
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/**
 * Invokes the fixture's admin-only `upgrade(new_wasm_hash)` and waits until it has been applied.
 * The ledger close time is not returned: it is stamped by the network, and comparing it with the local
 * clock gives skewed results.
 */
export async function upgradeContract(
  server: rpc.Server,
  env: FixtureEnvironment,
  wasmHashHex: string,
): Promise<void> {
  const keypair = Keypair.fromSecret(env.secret);
  const account = await server.getAccount(keypair.publicKey());
  const call = new Contract(env.fixture.contractId).call('upgrade', xdr.ScVal.scvBytes(hexToBytes(wasmHashHex)));
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: env.fixture.passphrase })
    .addOperation(call)
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`upgrade was rejected: ${JSON.stringify(sent.errorResult)}`);
  const result = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`upgrade transaction ${sent.hash} ended with status ${result.status}`);
  }
}
