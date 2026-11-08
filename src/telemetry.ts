import { ConfigError } from './errors.js';
import type { StatusChange } from './guard.js';
import type { HealthReport } from './health.js';
import {
  effectiveStatus,
  expiringEntry,
  EXPIRY_WARNING_LEDGERS,
  ledgersUntilExpiry,
} from './state.js';
import type { ContractState, Status } from './types.js';

/** Default sliding window capacity for per-endpoint latency samples. */
export const DEFAULT_MAX_LATENCY_SAMPLES = 256;

/** Default maximum number of status transitions retained in memory. */
export const DEFAULT_MAX_TRANSITION_HISTORY = 200;

/** Default maximum number of TTL warning samples retained in memory. */
export const DEFAULT_MAX_TTL_WARNING_SAMPLES = 100;

/** Classification of why a write-guard check was allowed or blocked. */
export type WriteCheckReason =
  | 'allowed'
  | 'not-started'
  | 'unsupported'
  | 'pending'
  | 'stale'
  | 'archived'
  | 'missing'
  | 'stellar-asset'
  | 'below-min-ttl'
  | 'fresh-lookup-failed';

/** Latency and reliability telemetry for a single configured RPC endpoint. */
export interface EndpointMetrics {
  endpointIndex: number;
  role: 'primary' | 'fallback';
  totalRequests: number;
  successes: number;
  failures: number;
  networkVerifications: number;
  networkFailures: number;
  minLatencyMs: number | undefined;
  maxLatencyMs: number | undefined;
  avgLatencyMs: number | undefined;
  p50LatencyMs: number | undefined;
  p95LatencyMs: number | undefined;
  p99LatencyMs: number | undefined;
  lastLatencyMs: number | undefined;
  lastUsedAt: number | undefined;
  lastError: string | undefined;
}

/** Emitted after each completed poll cycle of the version guard. */
export interface PollCycleEvent {
  cycleIndex: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  endpointIndex: number;
  usingFallback: boolean;
  everyLookupFailed: boolean;
  contractCount: number;
  supportedCount: number;
  blockedCount: number;
  errorCount: number;
  minTtlLedgers: number | undefined;
  ttlWarningCount: number;
  statuses: Record<string, Status>;
}

/** Listener notified after each poll cycle completes. */
export type TelemetryHook = (event: PollCycleEvent) => void | Promise<void>;

/** Historical record of a contract status transition. */
export interface StatusTransitionRecord {
  name: string;
  from: Status;
  to: Status;
  at: number;
  liveWasmHash?: string | undefined;
  matchedLabel?: string | undefined;
}

/** Recorded observation when a contract's remaining TTL drops below the warning threshold. */
export interface TtlWarningSample {
  at: number;
  contract: string;
  ledgersRemaining: number;
  expiringEntry: 'instance' | 'code';
}

/** Cumulative telemetry for a single guarded contract. */
export interface ContractMetrics {
  name: string;
  contractId: string;
  currentStatus: Status;
  polls: number;
  lookupSuccesses: number;
  lookupErrors: number;
  statusTransitions: number;
  writeChecksAllowed: number;
  writeChecksBlocked: number;
  blockedByReason: Partial<Record<WriteCheckReason, number>>;
  minObservedTtlLedgers: number | undefined;
  latestTtlLedgers: number | undefined;
  ttlWarnings: number;
}

/** Full telemetry snapshot across the guard, all RPC endpoints, and all guarded contracts. */
export interface GuardMetrics {
  startedAt: number | undefined;
  collectedAt: number;
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  failoverCount: number;
  activeEndpointIndex: number;
  usingFallback: boolean;
  totalWriteChecks: number;
  allowedWriteChecks: number;
  blockedWriteChecks: number;
  blockedByReason: Partial<Record<WriteCheckReason, number>>;
  endpoints: EndpointMetrics[];
  contracts: Record<string, ContractMetrics>;
  transitions: StatusTransitionRecord[];
  ttlWarningSamples: TtlWarningSample[];
}

/** Condensed operational indicators derived from {@link GuardMetrics}. */
export interface TelemetrySummary {
  totalPolls: number;
  pollSuccessRate: number;
  writeAllowRate: number;
  failoverCount: number;
  usingFallback: boolean;
  p95LatencyMs: number | undefined;
  unhealthyContracts: string[];
  ttlWarningContracts: string[];
  totalTransitions: number;
}

/** Combined health and telemetry diagnostics returned by `guard.diagnostics()`. */
export interface GuardDiagnostics {
  ok: boolean;
  health: HealthReport;
  metrics: GuardMetrics;
  summary: TelemetrySummary;
}

export interface MetricsCollectorOptions {
  /** Sliding window size for per-endpoint latency percentiles. Defaults to 256. */
  maxLatencySamples?: number | undefined;
  /** Maximum retained status transition records. Defaults to 200. */
  maxTransitionHistory?: number | undefined;
  /** Maximum retained TTL warning samples. Defaults to 100. */
  maxTtlWarningSamples?: number | undefined;
  /** Ledger threshold below which a contract triggers a TTL warning sample. Defaults to `EXPIRY_WARNING_LEDGERS`. */
  ttlWarningThresholdLedgers?: number | undefined;
  /** Clock in milliseconds since the Unix epoch. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export interface EndpointCallRecord {
  endpointIndex: number;
  kind: 'verify' | 'lookup';
  durationMs: number;
  ok: boolean;
  at?: number | undefined;
  error?: string | undefined;
}

export interface PollCycleInput {
  startedAt: number;
  completedAt: number;
  endpointIndex: number;
  usingFallback: boolean;
  everyLookupFailed: boolean;
  maxStalenessMs: number;
}

export interface MetricsCollector {
  /** Initializes the endpoint slots (primary + fallbacks) and contract entries if not already present. */
  initFleet(endpointCount: number, contracts: ReadonlyMap<string, { contractId: string }>): void;
  /** Records a network verification or ledger-entry lookup call against a specific RPC endpoint. */
  recordEndpointCall(event: EndpointCallRecord): void;
  /** Records an automatic failover from one RPC endpoint to another. */
  recordFailover(fromEndpoint: number, toEndpoint: number, at?: number): void;
  /** Records the completion of a poll cycle and updates per-contract poll and TTL counters. */
  recordPollCycle(states: Iterable<ContractState>, info: PollCycleInput): PollCycleEvent;
  /** Records a contract status transition. */
  recordTransition(change: StatusChange, at?: number): void;
  /** Records an allowed or blocked write assertion (`assertWritable` or `assertWritableFresh`). */
  recordWriteCheck(
    contract: string,
    contractId: string,
    outcome: { allowed: boolean; reason: WriteCheckReason; status: Status },
  ): void;
  /** Produces a deep, immutable snapshot of all collected metrics. */
  snapshot(at?: number): GuardMetrics;
  /** Clears all counters, latency windows, transitions, and TTL warning history. */
  reset(): void;
}

interface InternalEndpointState {
  endpointIndex: number;
  role: 'primary' | 'fallback';
  totalRequests: number;
  successes: number;
  failures: number;
  networkVerifications: number;
  networkFailures: number;
  latencies: number[];
  minLatencyMs: number | undefined;
  maxLatencyMs: number | undefined;
  lastLatencyMs: number | undefined;
  lastUsedAt: number | undefined;
  lastError: string | undefined;
}

interface InternalContractState {
  name: string;
  contractId: string;
  currentStatus: Status;
  polls: number;
  lookupSuccesses: number;
  lookupErrors: number;
  statusTransitions: number;
  writeChecksAllowed: number;
  writeChecksBlocked: number;
  blockedByReason: Partial<Record<WriteCheckReason, number>>;
  minObservedTtlLedgers: number | undefined;
  latestTtlLedgers: number | undefined;
  ttlWarnings: number;
}

function validatePositiveInt(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${String(value)}.`);
  }
  return value;
}

/** Computes a quantile (`0 <= q <= 1`) over a non-empty sorted ascending numeric array. */
function quantileSorted(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const clamped = Math.min(1, Math.max(0, q));
  const index = Math.ceil(clamped * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function makeEndpointState(endpointIndex: number): InternalEndpointState {
  return {
    endpointIndex,
    role: endpointIndex === 0 ? 'primary' : 'fallback',
    totalRequests: 0,
    successes: 0,
    failures: 0,
    networkVerifications: 0,
    networkFailures: 0,
    latencies: [],
    minLatencyMs: undefined,
    maxLatencyMs: undefined,
    lastLatencyMs: undefined,
    lastUsedAt: undefined,
    lastError: undefined,
  };
}

function makeContractState(name: string, contractId: string): InternalContractState {
  return {
    name,
    contractId,
    currentStatus: 'pending',
    polls: 0,
    lookupSuccesses: 0,
    lookupErrors: 0,
    statusTransitions: 0,
    writeChecksAllowed: 0,
    writeChecksBlocked: 0,
    blockedByReason: {},
    minObservedTtlLedgers: undefined,
    latestTtlLedgers: undefined,
    ttlWarnings: 0,
  };
}

function snapshotEndpoint(state: InternalEndpointState): EndpointMetrics {
  const sorted = [...state.latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const avg = sorted.length > 0 ? Math.round((sum / sorted.length) * 100) / 100 : undefined;
  return {
    endpointIndex: state.endpointIndex,
    role: state.role,
    totalRequests: state.totalRequests,
    successes: state.successes,
    failures: state.failures,
    networkVerifications: state.networkVerifications,
    networkFailures: state.networkFailures,
    minLatencyMs: state.minLatencyMs,
    maxLatencyMs: state.maxLatencyMs,
    avgLatencyMs: avg,
    p50LatencyMs: quantileSorted(sorted, 0.5),
    p95LatencyMs: quantileSorted(sorted, 0.95),
    p99LatencyMs: quantileSorted(sorted, 0.99),
    lastLatencyMs: state.lastLatencyMs,
    lastUsedAt: state.lastUsedAt,
    lastError: state.lastError,
  };
}

/**
 * Creates a bounded in-memory telemetry collector for `VersionGuard` and `EndpointSet`.
 */
export function createMetricsCollector(options: MetricsCollectorOptions = {}): MetricsCollector {
  const maxLatencySamples = validatePositiveInt(
    options.maxLatencySamples,
    'maxLatencySamples',
    DEFAULT_MAX_LATENCY_SAMPLES,
  );
  const maxTransitionHistory = validatePositiveInt(
    options.maxTransitionHistory,
    'maxTransitionHistory',
    DEFAULT_MAX_TRANSITION_HISTORY,
  );
  const maxTtlWarningSamples = validatePositiveInt(
    options.maxTtlWarningSamples,
    'maxTtlWarningSamples',
    DEFAULT_MAX_TTL_WARNING_SAMPLES,
  );
  const ttlWarningThresholdLedgers = validatePositiveInt(
    options.ttlWarningThresholdLedgers,
    'ttlWarningThresholdLedgers',
    EXPIRY_WARNING_LEDGERS,
  );
  const clock = options.now ?? Date.now;

  let startedAt: number | undefined;
  let totalPolls = 0;
  let successfulPolls = 0;
  let failedPolls = 0;
  let failoverCount = 0;
  let activeEndpointIndex = 0;
  let usingFallback = false;
  let totalWriteChecks = 0;
  let allowedWriteChecks = 0;
  let blockedWriteChecks = 0;
  let blockedByReason: Partial<Record<WriteCheckReason, number>> = {};

  const endpoints = new Map<number, InternalEndpointState>();
  const contracts = new Map<string, InternalContractState>();
  const transitions: StatusTransitionRecord[] = [];
  const ttlWarningSamples: TtlWarningSample[] = [];

  function ensureEndpoint(index: number): InternalEndpointState {
    let entry = endpoints.get(index);
    if (entry === undefined) {
      entry = makeEndpointState(index);
      endpoints.set(index, entry);
    }
    return entry;
  }

  function ensureContract(name: string, contractId: string): InternalContractState {
    let entry = contracts.get(name);
    if (entry === undefined) {
      entry = makeContractState(name, contractId);
      contracts.set(name, entry);
    }
    return entry;
  }

  return {
    initFleet(endpointCount: number, fleetContracts: ReadonlyMap<string, { contractId: string }>): void {
      for (let i = 0; i < endpointCount; i += 1) {
        ensureEndpoint(i);
      }
      for (const [name, cfg] of fleetContracts) {
        ensureContract(name, cfg.contractId);
      }
    },

    recordEndpointCall(event: EndpointCallRecord): void {
      const at = event.at ?? clock();
      if (startedAt === undefined) startedAt = at;
      const endpoint = ensureEndpoint(event.endpointIndex);
      const duration = Math.max(0, Math.round(event.durationMs * 100) / 100);
      endpoint.totalRequests += 1;
      endpoint.lastLatencyMs = duration;
      endpoint.lastUsedAt = at;
      endpoint.latencies.push(duration);
      if (endpoint.latencies.length > maxLatencySamples) {
        endpoint.latencies.shift();
      }
      endpoint.minLatencyMs =
        endpoint.minLatencyMs === undefined ? duration : Math.min(endpoint.minLatencyMs, duration);
      endpoint.maxLatencyMs =
        endpoint.maxLatencyMs === undefined ? duration : Math.max(endpoint.maxLatencyMs, duration);

      if (event.kind === 'verify') {
        endpoint.networkVerifications += 1;
        if (!event.ok) endpoint.networkFailures += 1;
      }

      if (event.ok) {
        endpoint.successes += 1;
        activeEndpointIndex = event.endpointIndex;
        usingFallback = event.endpointIndex !== 0;
      } else {
        endpoint.failures += 1;
        if (event.error !== undefined) endpoint.lastError = event.error;
      }
    },

    recordFailover(_fromEndpoint: number, toEndpoint: number, at?: number): void {
      const timestamp = at ?? clock();
      if (startedAt === undefined) startedAt = timestamp;
      failoverCount += 1;
      activeEndpointIndex = toEndpoint;
      usingFallback = toEndpoint !== 0;
      ensureEndpoint(_fromEndpoint);
      ensureEndpoint(toEndpoint);
    },

    recordPollCycle(states: Iterable<ContractState>, info: PollCycleInput): PollCycleEvent {
      if (startedAt === undefined) startedAt = info.startedAt;
      totalPolls += 1;
      const cycleIndex = totalPolls;
      if (info.everyLookupFailed) {
        failedPolls += 1;
      } else {
        successfulPolls += 1;
      }
      activeEndpointIndex = info.endpointIndex;
      usingFallback = info.usingFallback;

      let contractCount = 0;
      let supportedCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let minTtlLedgers: number | undefined;
      let ttlWarningCount = 0;
      const statuses: Record<string, Status> = {};

      for (const state of states) {
        contractCount += 1;
        const cMetrics = ensureContract(state.name, state.contractId);
        cMetrics.polls += 1;
        const status = effectiveStatus(state, info.completedAt, info.maxStalenessMs);
        cMetrics.currentStatus = status;
        statuses[state.name] = status;

        if (status === 'supported') {
          supportedCount += 1;
        } else {
          blockedCount += 1;
        }

        if (state.consecutiveErrors > 0) {
          errorCount += 1;
          cMetrics.lookupErrors += 1;
        } else {
          cMetrics.lookupSuccesses += 1;
        }

        const remaining = ledgersUntilExpiry(state);
        if (remaining !== undefined) {
          cMetrics.latestTtlLedgers = remaining;
          cMetrics.minObservedTtlLedgers =
            cMetrics.minObservedTtlLedgers === undefined
              ? remaining
              : Math.min(cMetrics.minObservedTtlLedgers, remaining);
          minTtlLedgers = minTtlLedgers === undefined ? remaining : Math.min(minTtlLedgers, remaining);
          if (remaining < ttlWarningThresholdLedgers) {
            ttlWarningCount += 1;
            cMetrics.ttlWarnings += 1;
            const entry = expiringEntry(state) ?? 'instance';
            ttlWarningSamples.push({
              at: info.completedAt,
              contract: state.name,
              ledgersRemaining: remaining,
              expiringEntry: entry,
            });
            if (ttlWarningSamples.length > maxTtlWarningSamples) {
              ttlWarningSamples.shift();
            }
          }
        }
      }

      return {
        cycleIndex,
        startedAt: info.startedAt,
        completedAt: info.completedAt,
        durationMs: Math.max(0, info.completedAt - info.startedAt),
        endpointIndex: info.endpointIndex,
        usingFallback: info.usingFallback,
        everyLookupFailed: info.everyLookupFailed,
        contractCount,
        supportedCount,
        blockedCount,
        errorCount,
        minTtlLedgers,
        ttlWarningCount,
        statuses,
      };
    },

    recordTransition(change: StatusChange, at?: number): void {
      const timestamp = at ?? clock();
      if (startedAt === undefined) startedAt = timestamp;
      const cMetrics = ensureContract(change.name, change.state.contractId);
      cMetrics.statusTransitions += 1;
      cMetrics.currentStatus = change.to;

      const record: StatusTransitionRecord = {
        name: change.name,
        from: change.from,
        to: change.to,
        at: timestamp,
        ...(change.state.liveWasmHash === undefined ? {} : { liveWasmHash: change.state.liveWasmHash }),
        ...(change.state.matchedLabel === undefined ? {} : { matchedLabel: change.state.matchedLabel }),
      };
      transitions.push(record);
      if (transitions.length > maxTransitionHistory) {
        transitions.shift();
      }
    },

    recordWriteCheck(
      contract: string,
      contractId: string,
      outcome: { allowed: boolean; reason: WriteCheckReason; status: Status },
    ): void {
      const cMetrics = ensureContract(contract, contractId);
      cMetrics.currentStatus = outcome.status;
      totalWriteChecks += 1;
      if (outcome.allowed) {
        allowedWriteChecks += 1;
        cMetrics.writeChecksAllowed += 1;
      } else {
        blockedWriteChecks += 1;
        cMetrics.writeChecksBlocked += 1;
        blockedByReason[outcome.reason] = (blockedByReason[outcome.reason] ?? 0) + 1;
        cMetrics.blockedByReason[outcome.reason] = (cMetrics.blockedByReason[outcome.reason] ?? 0) + 1;
      }
    },

    snapshot(at?: number): GuardMetrics {
      const collectedAt = at ?? clock();
      const sortedEndpoints = [...endpoints.keys()]
        .sort((a, b) => a - b)
        .map((idx) => snapshotEndpoint(endpoints.get(idx) as InternalEndpointState));

      const contractOut: Record<string, ContractMetrics> = {};
      for (const [name, cState] of contracts) {
        contractOut[name] = {
          name: cState.name,
          contractId: cState.contractId,
          currentStatus: cState.currentStatus,
          polls: cState.polls,
          lookupSuccesses: cState.lookupSuccesses,
          lookupErrors: cState.lookupErrors,
          statusTransitions: cState.statusTransitions,
          writeChecksAllowed: cState.writeChecksAllowed,
          writeChecksBlocked: cState.writeChecksBlocked,
          blockedByReason: { ...cState.blockedByReason },
          minObservedTtlLedgers: cState.minObservedTtlLedgers,
          latestTtlLedgers: cState.latestTtlLedgers,
          ttlWarnings: cState.ttlWarnings,
        };
      }

      return {
        startedAt,
        collectedAt,
        totalPolls,
        successfulPolls,
        failedPolls,
        failoverCount,
        activeEndpointIndex,
        usingFallback,
        totalWriteChecks,
        allowedWriteChecks,
        blockedWriteChecks,
        blockedByReason: { ...blockedByReason },
        endpoints: sortedEndpoints,
        contracts: contractOut,
        transitions: transitions.map((item) => ({ ...item })),
        ttlWarningSamples: ttlWarningSamples.map((item) => ({ ...item })),
      };
    },

    reset(): void {
      startedAt = undefined;
      totalPolls = 0;
      successfulPolls = 0;
      failedPolls = 0;
      failoverCount = 0;
      activeEndpointIndex = 0;
      usingFallback = false;
      totalWriteChecks = 0;
      allowedWriteChecks = 0;
      blockedWriteChecks = 0;
      blockedByReason = {};
      for (const [idx] of endpoints) {
        endpoints.set(idx, makeEndpointState(idx));
      }
      for (const [name, cState] of contracts) {
        contracts.set(name, makeContractState(name, cState.contractId));
      }
      transitions.length = 0;
      ttlWarningSamples.length = 0;
    },
  };
}

/**
 * Computes a high-level operational summary from {@link GuardMetrics} and an optional {@link HealthReport}.
 */
export function summarizeTelemetry(metrics: GuardMetrics, health?: HealthReport): TelemetrySummary {
  const pollSuccessRate =
    metrics.totalPolls > 0 ? Math.round((metrics.successfulPolls / metrics.totalPolls) * 10_000) / 10_000 : 1;
  const writeAllowRate =
    metrics.totalWriteChecks > 0
      ? Math.round((metrics.allowedWriteChecks / metrics.totalWriteChecks) * 10_000) / 10_000
      : 1;

  const activeEndpoint =
    metrics.endpoints.find((ep) => ep.endpointIndex === metrics.activeEndpointIndex) ?? metrics.endpoints[0];
  const p95LatencyMs = activeEndpoint?.p95LatencyMs;

  const unhealthyContracts: string[] = [];
  const ttlWarningContracts: string[] = [];

  for (const [name, contract] of Object.entries(metrics.contracts)) {
    const effective = health?.contracts[name]?.status ?? contract.currentStatus;
    if (effective !== 'supported') {
      unhealthyContracts.push(name);
    }
    const ttl = health?.contracts[name]?.ledgersUntilExpiry ?? contract.latestTtlLedgers;
    if (ttl !== undefined && ttl < EXPIRY_WARNING_LEDGERS) {
      ttlWarningContracts.push(name);
    }
  }

  if (health !== undefined) {
    for (const [name, cHealth] of Object.entries(health.contracts)) {
      if (!Object.hasOwn(metrics.contracts, name)) {
        if (cHealth.status !== 'supported') unhealthyContracts.push(name);
        if (cHealth.ledgersUntilExpiry !== undefined && cHealth.ledgersUntilExpiry < EXPIRY_WARNING_LEDGERS) {
          ttlWarningContracts.push(name);
        }
      }
    }
  }

  return {
    totalPolls: metrics.totalPolls,
    pollSuccessRate,
    writeAllowRate,
    failoverCount: metrics.failoverCount,
    usingFallback: health?.network.usingFallback ?? metrics.usingFallback,
    p95LatencyMs,
    unhealthyContracts: unhealthyContracts.sort(),
    ttlWarningContracts: ttlWarningContracts.sort(),
    totalTransitions: metrics.transitions.length,
  };
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function isHealthReport(input: GuardMetrics | HealthReport): input is HealthReport {
  return 'ok' in input && 'network' in input && !('totalPolls' in input);
}

/**
 * Formats either a {@link GuardMetrics} snapshot (optionally paired with a {@link HealthReport})
 * or a standalone {@link HealthReport} in standard Prometheus text exposition format (0.0.4).
 */
export function formatPrometheusMetrics(
  input: GuardMetrics | HealthReport,
  options: { prefix?: string | undefined; health?: HealthReport | undefined } = {},
): string {
  const prefix = (options.prefix ?? 'wasmward').replace(/[^a-zA-Z0-9_]/g, '_');
  const lines: string[] = [];

  const health = isHealthReport(input) ? input : options.health;
  const metrics = isHealthReport(input) ? undefined : input;

  if (health !== undefined) {
    lines.push(`# HELP ${prefix}_guard_ok Whether the network is verified and all contracts are supported (1 = ok, 0 = blocked).`);
    lines.push(`# TYPE ${prefix}_guard_ok gauge`);
    lines.push(`${prefix}_guard_ok ${health.ok ? 1 : 0}`);

    lines.push(`# HELP ${prefix}_network_verified Whether the RPC network passphrase has been verified (1 = yes, 0 = no).`);
    lines.push(`# TYPE ${prefix}_network_verified gauge`);
    lines.push(
      `${prefix}_network_verified{passphrase="${escapePrometheusLabel(health.network.passphrase)}"} ${health.network.verified ? 1 : 0}`,
    );

    lines.push(`# HELP ${prefix}_network_using_fallback Whether the guard is currently using a fallback RPC endpoint (1 = fallback, 0 = primary).`);
    lines.push(`# TYPE ${prefix}_network_using_fallback gauge`);
    lines.push(`${prefix}_network_using_fallback ${health.network.usingFallback ? 1 : 0}`);

    lines.push(`# HELP ${prefix}_contract_writable Whether writes to a contract are currently allowed (1 = writable, 0 = blocked).`);
    lines.push(`# TYPE ${prefix}_contract_writable gauge`);
    for (const [name, cHealth] of Object.entries(health.contracts)) {
      lines.push(
        `${prefix}_contract_writable{contract="${escapePrometheusLabel(name)}",contract_id="${escapePrometheusLabel(cHealth.contractId)}",status="${escapePrometheusLabel(cHealth.status)}"} ${cHealth.writable ? 1 : 0}`,
      );
    }

    lines.push(`# HELP ${prefix}_contract_ttl_ledgers Remaining ledgers until instance or Wasm code expiry.`);
    lines.push(`# TYPE ${prefix}_contract_ttl_ledgers gauge`);
    for (const [name, cHealth] of Object.entries(health.contracts)) {
      if (cHealth.ledgersUntilExpiry !== undefined) {
        const entry = cHealth.expiringEntry ?? 'instance';
        lines.push(
          `${prefix}_contract_ttl_ledgers{contract="${escapePrometheusLabel(name)}",expiring_entry="${entry}"} ${cHealth.ledgersUntilExpiry}`,
        );
      }
    }

    lines.push(`# HELP ${prefix}_contract_consecutive_errors Consecutive lookup errors for a contract.`);
    lines.push(`# TYPE ${prefix}_contract_consecutive_errors gauge`);
    for (const [name, cHealth] of Object.entries(health.contracts)) {
      lines.push(
        `${prefix}_contract_consecutive_errors{contract="${escapePrometheusLabel(name)}"} ${cHealth.consecutiveErrors}`,
      );
    }
  }

  if (metrics !== undefined) {
    lines.push(`# HELP ${prefix}_polls_total Total number of poll cycles executed.`);
    lines.push(`# TYPE ${prefix}_polls_total counter`);
    lines.push(`${prefix}_polls_total{outcome="success"} ${metrics.successfulPolls}`);
    lines.push(`${prefix}_polls_total{outcome="failure"} ${metrics.failedPolls}`);

    lines.push(`# HELP ${prefix}_failovers_total Total number of RPC endpoint failovers.`);
    lines.push(`# TYPE ${prefix}_failovers_total counter`);
    lines.push(`${prefix}_failovers_total ${metrics.failoverCount}`);

    lines.push(`# HELP ${prefix}_write_checks_total Total number of write-guard checks performed.`);
    lines.push(`# TYPE ${prefix}_write_checks_total counter`);
    lines.push(`${prefix}_write_checks_total{outcome="allowed"} ${metrics.allowedWriteChecks}`);
    lines.push(`${prefix}_write_checks_total{outcome="blocked"} ${metrics.blockedWriteChecks}`);

    lines.push(`# HELP ${prefix}_endpoint_requests_total Total RPC requests per endpoint index and role.`);
    lines.push(`# TYPE ${prefix}_endpoint_requests_total counter`);
    for (const ep of metrics.endpoints) {
      lines.push(
        `${prefix}_endpoint_requests_total{endpoint="${ep.endpointIndex}",role="${ep.role}",outcome="success"} ${ep.successes}`,
      );
      lines.push(
        `${prefix}_endpoint_requests_total{endpoint="${ep.endpointIndex}",role="${ep.role}",outcome="failure"} ${ep.failures}`,
      );
    }

    lines.push(`# HELP ${prefix}_endpoint_latency_ms RPC endpoint latency statistics in milliseconds.`);
    lines.push(`# TYPE ${prefix}_endpoint_latency_ms gauge`);
    for (const ep of metrics.endpoints) {
      if (ep.p50LatencyMs !== undefined) {
        lines.push(`${prefix}_endpoint_latency_ms{endpoint="${ep.endpointIndex}",role="${ep.role}",quantile="0.5"} ${ep.p50LatencyMs}`);
      }
      if (ep.p95LatencyMs !== undefined) {
        lines.push(`${prefix}_endpoint_latency_ms{endpoint="${ep.endpointIndex}",role="${ep.role}",quantile="0.95"} ${ep.p95LatencyMs}`);
      }
      if (ep.p99LatencyMs !== undefined) {
        lines.push(`${prefix}_endpoint_latency_ms{endpoint="${ep.endpointIndex}",role="${ep.role}",quantile="0.99"} ${ep.p99LatencyMs}`);
      }
    }

    lines.push(`# HELP ${prefix}_contract_transitions_total Total status transitions observed per contract.`);
    lines.push(`# TYPE ${prefix}_contract_transitions_total counter`);
    for (const [name, cMetrics] of Object.entries(metrics.contracts)) {
      lines.push(
        `${prefix}_contract_transitions_total{contract="${escapePrometheusLabel(name)}"} ${cMetrics.statusTransitions}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
