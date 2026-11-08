import { rpc } from '@stellar/stellar-sdk';
import { usesPlainHttp } from './config.js';
import { ConfigError } from './errors.js';
import { fetchExecutables, withTimeout, type LedgerEntriesSource } from './fetch.js';
import type { EndpointCallRecord } from './telemetry.js';
import type { LiveExecutable } from './types.js';

/** The parts of `rpc.Server` the guard uses. `rpc.Server` satisfies it. */
export interface GuardServer extends LedgerEntriesSource {
  getNetwork(): Promise<{ passphrase: string }>;
}

export interface EndpointSetOptions {
  onEndpointCall?: ((event: EndpointCallRecord) => void) | undefined;
  onFailover?: ((fromEndpoint: number, toEndpoint: number, at: number) => void) | undefined;
  now?: (() => number) | undefined;
}

/**
 * How long past a lookup's own timeout the HTTP request itself is allowed to live. The lookup gives up at its
 * timeout with a clear message; this slack makes sure that message, not a transport error, is the one reported.
 */
export const CLIENT_ABORT_SLACK_MS = 1_000;

/**
 * An RPC client that really abandons a request that takes too long.
 *
 * Giving up on a request is not the same as cancelling it: without a transport timeout a hung RPC leaves
 * its connection open, one per poll during an outage, and keeps a short-lived process such as the CLI
 * alive after it has already printed its answer. `rpc.Server` declares a `timeout` option but, in
 * @stellar/stellar-sdk 17.2.1, never reads it, so the timeout is set on the HTTP client the SDK does use.
 */
export function createRpcClient(url: string, timeoutMs: number): GuardServer {
  const client = new rpc.Server(url, { allowHttp: usesPlainHttp(url) });
  client.httpClient.defaults.timeout = timeoutMs + CLIENT_ABORT_SLACK_MS;
  return client;
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
  /** Index of the active RPC endpoint (0 for primary, 1+ for fallbacks). */
  readonly activeEndpointIndex: number;
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
  options: EndpointSetOptions = {},
): EndpointSet {
  if (servers.length === 0) throw new Error('createEndpointSet needs at least one server');

  const clock = options.now ?? Date.now;
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
    const startedAt = clock();
    let actual: string;
    try {
      actual = (await withTimeout(server.getNetwork(), verifyTimeoutMs, 'getNetwork')).passphrase;
    } catch (error) {
      const finishedAt = clock();
      options.onEndpointCall?.({
        endpointIndex: index,
        kind: 'verify',
        durationMs: Math.max(0, finishedAt - startedAt),
        ok: false,
        at: finishedAt,
        error: messageOf(error),
      });
      throw error;
    }
    const finishedAt = clock();
    if (actual !== passphrase) {
      const message = wrongNetwork(index, actual);
      rejected.set(index, message);
      options.onEndpointCall?.({
        endpointIndex: index,
        kind: 'verify',
        durationMs: Math.max(0, finishedAt - startedAt),
        ok: false,
        at: finishedAt,
        error: message,
      });
      throw new ConfigError(message);
    }
    options.onEndpointCall?.({
      endpointIndex: index,
      kind: 'verify',
      durationMs: Math.max(0, finishedAt - startedAt),
      ok: true,
      at: finishedAt,
    });
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

    get activeEndpointIndex(): number {
      return preferred;
    },

    async verifyNetwork(): Promise<void> {
      const failures: string[] = [];
      for (let index = 0; index < servers.length; index += 1) {
        try {
          await verifyOne(index);
          if (index !== preferred) {
            options.onFailover?.(preferred, index, clock());
          }
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
      const sequence = order();
      const firstTried = sequence[0] ?? 0;

      for (const index of sequence) {
        try {
          await verifyOne(index);
        } catch (error) {
          failures.push(`endpoint ${index}: ${messageOf(error)}`);
          continue;
        }

        const startedAt = clock();
        const results = await fetchExecutables(servers[index] as GuardServer, contractIds, timeoutMs);
        const finishedAt = clock();
        const durationMs = Math.max(0, finishedAt - startedAt);
        const answered = [...results.values()].some((result) => result.kind !== 'error');
        if (answered || results.size === 0) {
          options.onEndpointCall?.({
            endpointIndex: index,
            kind: 'lookup',
            durationMs,
            ok: true,
            at: finishedAt,
          });
          if (index !== preferred || index !== firstTried) {
            if (index !== 0 || preferred !== 0) {
              options.onFailover?.(preferred, index, finishedAt);
            }
          }
          preferred = index;
          usingFallback = index !== 0;
          return results;
        }
        const first = [...results.values()].find((result) => result.kind === 'error');
        const errMessage = first?.kind === 'error' ? first.message : 'no answer';
        options.onEndpointCall?.({
          endpointIndex: index,
          kind: 'lookup',
          durationMs,
          ok: false,
          at: finishedAt,
          error: errMessage,
        });
        failures.push(`endpoint ${index}: ${errMessage}`);
      }

      const message =
        servers.length === 1
          ? failures[0]?.replace(/^endpoint 0: /, '') ?? 'no answer'
          : `all ${servers.length} RPC endpoints failed (${failures.join('; ')})`;
      return new Map(contractIds.map((id) => [id, { kind: 'error', message } as const]));
    },
  };
}
