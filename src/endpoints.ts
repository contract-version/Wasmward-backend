import { ConfigError } from './errors.js';
import { fetchExecutables, withTimeout, type LedgerEntriesSource } from './fetch.js';
import type { LiveExecutable } from './types.js';

/** The parts of `rpc.Server` the guard uses. `rpc.Server` satisfies it. */
export interface GuardServer extends LedgerEntriesSource {
  getNetwork(): Promise<{ passphrase: string }>;
}

/** While running on a fallback, the primary endpoint is tried first again once in this many lookups. */
export const PRIMARY_RETRY_EVERY = 6;

export interface EndpointSet {
  /**
   * Confirms an endpoint serves the configured network. The primary is tried first; if it cannot be
   * reached, each fallback is tried in turn. An endpoint that answers with a different network is a
   * misconfiguration and throws {@link ConfigError} when it is the primary.
   */
  verifyNetwork(): Promise<void>;
  /**
   * Looks up the live executable of each contract, failing over to the next endpoint when one cannot
   * answer at all. Every requested contract appears in the result; failures come back as `error`.
   */
  lookup(contractIds: readonly string[], timeoutMs: number): Promise<Map<string, LiveExecutable>>;
  /** True when the most recent successful lookup came from a fallback rather than the primary. */
  readonly usingFallback: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps one primary RPC client and any number of fallbacks. With no fallbacks it behaves exactly like
 * the primary alone.
 *
 * Fail-closed rules:
 * - No endpoint is used for lookups until it has reported the configured network passphrase, so a
 *   fallback that points at another network can never make a contract look `supported`.
 * - Failing over only happens when a lookup produced no usable answer for any contract. A contract-level
 *   error (malformed data, say) is not a reason to ask someone else.
 */
export function createEndpointSet(
  servers: readonly GuardServer[],
  passphrase: string,
  verifyTimeoutMs: number,
): EndpointSet {
  if (servers.length === 0) throw new Error('createEndpointSet needs at least one server');

  const verified = new Set<number>();
  /** Endpoints that reported a different network. They are never used. */
  const rejected = new Map<number, string>();
  let preferred = 0;
  let lookups = 0;
  let usingFallback = false;

  const wrongNetwork = (index: number, actual: string): string =>
    `The RPC serves network "${actual}" but the config expects "${passphrase}".` +
    (index === 0 ? '' : ` (fallback endpoint ${index})`);

  /** Checks one endpoint's network. Resolves when it is verified; throws a plain Error when it is not usable. */
  async function verifyOne(index: number): Promise<void> {
    if (verified.has(index)) return;
    const known = rejected.get(index);
    // A rejected endpoint is on the wrong network, which is always a configuration problem. Keep saying so on
    // every later ask, or a retry would look like an outage and move on to a fallback.
    if (known !== undefined) throw new ConfigError(known);
    const server = servers[index] as GuardServer;
    const actual = (await withTimeout(server.getNetwork(), verifyTimeoutMs, 'getNetwork')).passphrase;
    if (actual !== passphrase) {
      const message = wrongNetwork(index, actual);
      rejected.set(index, message);
      throw new ConfigError(message);
    }
    verified.add(index);
  }

  function order(): number[] {
    const all = servers.map((_, index) => index);
    const first = preferred !== 0 && lookups % PRIMARY_RETRY_EVERY === 0 ? 0 : preferred;
    return [first, ...all.filter((index) => index !== first)];
  }

  return {
    get usingFallback(): boolean {
      return usingFallback;
    },

    async verifyNetwork(): Promise<void> {
      const failures: string[] = [];
      for (let index = 0; index < servers.length; index += 1) {
        try {
          await verifyOne(index);
          preferred = index;
          usingFallback = index !== 0;
          return;
        } catch (error) {
          // The primary serving the wrong network is a configuration mistake, not an outage.
          if (index === 0 && error instanceof ConfigError) throw error;
          failures.push(messageOf(error));
        }
      }
      const detail =
        servers.length === 1
          ? (failures[0] ?? 'unknown error')
          : `all ${servers.length} RPC endpoints failed (${failures.map((m, i) => `endpoint ${i}: ${m}`).join('; ')})`;
      throw new Error(`Could not verify the network: ${detail}`);
    },

    async lookup(contractIds: readonly string[], timeoutMs: number): Promise<Map<string, LiveExecutable>> {
      lookups += 1;
      const failures: string[] = [];

      for (const index of order()) {
        try {
          await verifyOne(index);
        } catch (error) {
          failures.push(`endpoint ${index}: ${messageOf(error)}`);
          continue;
        }

        const results = await fetchExecutables(servers[index] as GuardServer, contractIds, timeoutMs);
        const answered = [...results.values()].some((result) => result.kind !== 'error');
        if (answered || results.size === 0) {
          preferred = index;
          usingFallback = index !== 0;
          return results;
        }
        const first = [...results.values()].find((result) => result.kind === 'error');
        failures.push(`endpoint ${index}: ${first?.kind === 'error' ? first.message : 'no answer'}`);
      }

      const message =
        servers.length === 1
          ? failures[0]?.replace(/^endpoint 0: /, '') ?? 'no answer'
          : `all ${servers.length} RPC endpoints failed (${failures.join('; ')})`;
      return new Map(contractIds.map((id) => [id, { kind: 'error', message } as const]));
    },
  };
}
