import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, WriteBlockedError } from '../../src/errors.js';
import { createVersionGuard, type VersionGuard } from '../../src/guard.js';
import {
  createMetricsCollector,
  formatPrometheusMetrics,
  summarizeTelemetry,
  type PollCycleEvent,
} from '../../src/telemetry.js';
import type { WasmwardConfigInput } from '../../src/types.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const POOL = contractIdOf(2);
const V1 = hashOf(1);
const V2 = hashOf(2);

function makeConfig(overrides: Partial<WasmwardConfigInput> = {}): WasmwardConfigInput {
  return {
    version: 1,
    network: {
      rpcUrl: 'https://primary.example.org',
      fallbackRpcUrls: ['https://fallback1.example.org'],
      passphrase: PASSPHRASE,
    },
    pollIntervalMs: 10_000,
    maxStalenessMs: 40_000,
    contracts: {
      vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1.0.0' }] },
      pool: { contractId: POOL, supported: [{ wasmHash: V1, label: 'v1.0.0' }] },
    },
    ...overrides,
  };
}

describe('createMetricsCollector', () => {
  it('validates positive integer options and throws ConfigError on invalid values', () => {
    expect(() => createMetricsCollector({ maxLatencySamples: 0 })).toThrow(ConfigError);
    expect(() => createMetricsCollector({ maxLatencySamples: -5 })).toThrow(ConfigError);
    expect(() => createMetricsCollector({ maxLatencySamples: 1.5 })).toThrow(ConfigError);
    expect(() => createMetricsCollector({ maxTransitionHistory: 0 })).toThrow(ConfigError);
    expect(() => createMetricsCollector({ maxTtlWarningSamples: 0 })).toThrow(ConfigError);
    expect(() => createMetricsCollector({ ttlWarningThresholdLedgers: 0 })).toThrow(ConfigError);
  });

  it('tracks endpoint latencies, min/max/avg/p50/p95/p99, and sliding window eviction', () => {
    let clock = 1_000;
    const collector = createMetricsCollector({ maxLatencySamples: 5, now: () => clock });
    collector.initFleet(2, new Map([['vault', { contractId: VAULT }]]));

    const samples = [10, 20, 30, 40, 50, 100];
    for (const durationMs of samples) {
      clock += 100;
      collector.recordEndpointCall({
        endpointIndex: 0,
        kind: 'lookup',
        durationMs,
        ok: true,
      });
    }

    collector.recordEndpointCall({
      endpointIndex: 1,
      kind: 'verify',
      durationMs: 250,
      ok: false,
      error: 'connection reset',
    });

    const snap = collector.snapshot();
    expect(snap.startedAt).toBe(1_100);
    expect(snap.endpoints).toHaveLength(2);

    const ep0 = snap.endpoints[0];
    expect(ep0).toMatchObject({
      endpointIndex: 0,
      role: 'primary',
      totalRequests: 6,
      successes: 6,
      failures: 0,
      minLatencyMs: 10,
      maxLatencyMs: 100,
      // Window of last 5 samples: [20, 30, 40, 50, 100], average = 48
      avgLatencyMs: 48,
      p50LatencyMs: 40,
      p95LatencyMs: 100,
      p99LatencyMs: 100,
      lastLatencyMs: 100,
    });

    const ep1 = snap.endpoints[1];
    expect(ep1).toMatchObject({
      endpointIndex: 1,
      role: 'fallback',
      totalRequests: 1,
      successes: 0,
      failures: 1,
      networkVerifications: 1,
      networkFailures: 1,
      lastError: 'connection reset',
    });
  });

  it('caps transition history and TTL warning samples to configured limits', () => {
    const collector = createMetricsCollector({
      maxTransitionHistory: 2,
      maxTtlWarningSamples: 2,
      ttlWarningThresholdLedgers: 1_000,
      now: () => 5_000,
    });

    const baseState = {
      name: 'vault',
      contractId: VAULT,
      status: 'supported' as const,
      consecutiveErrors: 0,
      liveWasmHash: V1,
      matchedLabel: 'v1',
      latestLedger: 100,
      liveUntilLedger: 500,
      codeLiveUntilLedger: 800,
    };

    collector.recordTransition({ name: 'vault', from: 'pending', to: 'supported', state: baseState }, 1_000);
    collector.recordTransition(
      { name: 'vault', from: 'supported', to: 'unsupported', state: { ...baseState, status: 'unsupported' } },
      2_000,
    );
    collector.recordTransition({ name: 'vault', from: 'unsupported', to: 'supported', state: baseState }, 3_000);

    for (let i = 1; i <= 3; i += 1) {
      collector.recordPollCycle([baseState], {
        startedAt: i * 1_000,
        completedAt: i * 1_000 + 25,
        endpointIndex: 0,
        usingFallback: false,
        everyLookupFailed: false,
        maxStalenessMs: 60_000,
      });
    }

    const snap = collector.snapshot();
    expect(snap.transitions).toHaveLength(2);
    expect(snap.transitions[0]?.at).toBe(2_000);
    expect(snap.transitions[1]?.at).toBe(3_000);
    expect(snap.ttlWarningSamples).toHaveLength(2);
    expect(snap.ttlWarningSamples[0]?.at).toBe(2_025);
    expect(snap.ttlWarningSamples[1]?.at).toBe(3_025);
    expect(snap.contracts['vault']?.ttlWarnings).toBe(3);
    expect(snap.contracts['vault']?.minObservedTtlLedgers).toBe(400);
  });

  it('resets all counters, windows, and histories cleanly', () => {
    const collector = createMetricsCollector({ now: () => 10_000 });
    collector.initFleet(1, new Map([['vault', { contractId: VAULT }]]));
    collector.recordEndpointCall({ endpointIndex: 0, kind: 'lookup', durationMs: 15, ok: true });
    collector.recordFailover(0, 1, 10_000);
    collector.recordWriteCheck('vault', VAULT, { allowed: false, reason: 'unsupported', status: 'unsupported' });

    expect(collector.snapshot().totalWriteChecks).toBe(1);
    expect(collector.snapshot().failoverCount).toBe(1);

    collector.reset();
    const after = collector.snapshot();
    expect(after.startedAt).toBeUndefined();
    expect(after.totalPolls).toBe(0);
    expect(after.failoverCount).toBe(0);
    expect(after.totalWriteChecks).toBe(0);
    expect(after.blockedByReason).toEqual({});
    expect(after.transitions).toEqual([]);
    expect(after.ttlWarningSamples).toEqual([]);
    expect(after.endpoints[0]?.totalRequests).toBe(0);
    expect(after.contracts['vault']?.writeChecksBlocked).toBe(0);
  });
});

describe('guard telemetry, metrics(), diagnostics(), and onPollCycle', () => {
  let primary: FakeChain;
  let fallback: FakeChain;
  const guards: VersionGuard[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    primary = new FakeChain();
    fallback = new FakeChain();
    primary.setWasm(VAULT, V1);
    primary.setWasm(POOL, V1);
    fallback.setWasm(VAULT, V1);
    fallback.setWasm(POOL, V1);
  });

  afterEach(async () => {
    for (const g of guards.splice(0)) await g.stop();
    vi.useRealTimers();
  });

  it('collects poll cycles, write check outcomes, failovers, and diagnostics', async () => {
    const cycleEvents: PollCycleEvent[] = [];
    let clock = 100_000;
    const guard = createVersionGuard(makeConfig(), {
      server: primary,
      fallbackServers: [fallback],
      now: () => clock,
      onPollCycle: (ev) => {
        cycleEvents.push(ev);
      },
    });
    guards.push(guard);

    // Write check before start -> blocked with reason 'not-started'
    expect(() => guard.assertWritable('vault')).toThrow(WriteBlockedError);
    await expect(guard.assertWritableFresh('vault')).rejects.toThrow(WriteBlockedError);

    await guard.start();
    expect(cycleEvents).toHaveLength(1);
    expect(cycleEvents[0]).toMatchObject({
      cycleIndex: 1,
      supportedCount: 2,
      blockedCount: 0,
      errorCount: 0,
      usingFallback: false,
      everyLookupFailed: false,
    });

    // Allowed write check
    guard.assertWritable('vault', { minTtlLedgers: 100 });
    // Blocked by minTtlLedgers
    expect(() => guard.assertWritable('vault', { minTtlLedgers: 999_999 })).toThrow(WriteBlockedError);

    // Simulate primary outage -> failover to fallback
    primary.failLookups = new Error('primary timeout');
    clock += 10_000;
    await vi.advanceTimersByTimeAsync(11_000);

    expect(cycleEvents).toHaveLength(2);
    expect(cycleEvents[1]?.usingFallback).toBe(true);
    expect(cycleEvents[1]?.endpointIndex).toBe(1);

    // Upgrade pool to unsupported hash on fallback
    fallback.setWasm(POOL, V2);
    clock += 10_000;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(() => guard.assertWritable('pool')).toThrow(WriteBlockedError);

    // Fresh lookup failure when both primary and fallback fail
    fallback.failLookups = new Error('fallback down');
    await expect(guard.assertWritableFresh('vault')).rejects.toThrow(WriteBlockedError);

    const diag = guard.diagnostics();
    expect(diag.ok).toBe(false);
    expect(diag.metrics.totalPolls).toBe(3);
    expect(diag.metrics.successfulPolls).toBe(3);
    expect(diag.metrics.failoverCount).toBeGreaterThanOrEqual(1);
    expect(diag.metrics.usingFallback).toBe(true);
    expect(diag.metrics.allowedWriteChecks).toBe(1);
    expect(diag.metrics.blockedWriteChecks).toBe(5);
    expect(diag.metrics.blockedByReason).toEqual({
      'not-started': 2,
      'below-min-ttl': 1,
      unsupported: 1,
      'fresh-lookup-failed': 1,
    });
    expect(diag.summary.unhealthyContracts).toContain('pool');
    expect(diag.summary.totalTransitions).toBeGreaterThanOrEqual(3);
  });

  it('ignores a throwing or rejecting onPollCycle hook without stopping the guard', async () => {
    let calls = 0;
    const guard = createVersionGuard(makeConfig(), {
      server: primary,
      fallbackServers: [fallback],
      onPollCycle: () => {
        calls += 1;
        if (calls === 1) throw new Error('sync hook error');
        return Promise.reject(new Error('async hook error'));
      },
    });
    guards.push(guard);

    await guard.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls).toBe(2);
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('formats Prometheus exposition text from GuardMetrics, HealthReport, or both', async () => {
    const guard = createVersionGuard(makeConfig(), {
      server: primary,
      fallbackServers: [fallback],
    });
    guards.push(guard);
    await guard.start();
    guard.assertWritable('vault');

    const healthOnly = formatPrometheusMetrics(guard.health());
    expect(healthOnly).toContain('# TYPE wasmward_guard_ok gauge');
    expect(healthOnly).toContain('wasmward_guard_ok 1');
    expect(healthOnly).toContain('wasmward_contract_writable{contract="vault"');
    expect(healthOnly).toContain('wasmward_contract_ttl_ledgers{contract="vault",expiring_entry="instance"} 5000');

    const combined = formatPrometheusMetrics(guard.metrics(), {
      prefix: 'custom_app',
      health: guard.health(),
    });
    expect(combined).toContain('custom_app_guard_ok 1');
    expect(combined).toContain('custom_app_polls_total{outcome="success"} 1');
    expect(combined).toContain('custom_app_write_checks_total{outcome="allowed"} 1');
    expect(combined).toContain('custom_app_endpoint_requests_total{endpoint="0",role="primary",outcome="success"}');
    expect(combined).toContain('custom_app_endpoint_latency_ms{endpoint="0",role="primary",quantile="0.95"}');
  });

  it('summarizes telemetry with standalone metrics or paired health report', () => {
    const collector = createMetricsCollector({ now: () => 2_000 });
    collector.initFleet(1, new Map([['vault', { contractId: VAULT }]]));
    const emptySummary = summarizeTelemetry(collector.snapshot());
    expect(emptySummary.pollSuccessRate).toBe(1);
    expect(emptySummary.writeAllowRate).toBe(1);
    expect(emptySummary.unhealthyContracts).toEqual(['vault']);
  });
});
