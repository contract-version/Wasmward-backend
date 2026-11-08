import { describe, expect, it } from 'vitest';
import {
  auditConfig,
  diffConfigs,
  formatAuditReport,
  formatConfigDiff,
  formatHealthTable,
  summarizeHealthReport,
  validateUpgradePlan,
} from '../../src/audit.js';
import { ConfigError } from '../../src/errors.js';
import type { HealthReport } from '../../src/health.js';
import { PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const POOL = contractIdOf(2);
const ROUTER = contractIdOf(3);
const V1 = hashOf(1);
const V2 = hashOf(2);
const V3 = hashOf(3);
const V4 = hashOf(4);

function cleanSingleConfig(): Record<string, unknown> {
  return {
    version: 1,
    network: {
      rpcUrl: 'https://primary.stellar-rpc.example.org',
      fallbackRpcUrls: ['https://fallback.stellar-rpc.example.org'],
      passphrase: PASSPHRASE,
    },
    pollIntervalMs: 15_000,
    maxStalenessMs: 60_000,
    contracts: {
      vault: {
        contractId: VAULT,
        supported: [{ wasmHash: V1, label: 'v1.0.0' }],
      },
    },
  };
}

describe('auditConfig', () => {
  it('scores a hardened config 100/100 with zero findings', () => {
    const report = auditConfig(cleanSingleConfig(), { strict: true });
    expect(report).toEqual({
      ok: true,
      score: 100,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      findings: [],
      checkedNetworks: 1,
      checkedContracts: 1,
    });
    expect(formatAuditReport(report)).toContain('No operational or security issues found.');
  });

  it('detects single-rpc-endpoint, localhost-rpc-endpoint, high-poll-interval, and wide-staleness-window', () => {
    const report = auditConfig({
      version: 1,
      network: {
        rpcUrl: 'http://127.0.0.1:8000',
        passphrase: PASSPHRASE,
      },
      pollIntervalMs: 120_000,
      maxStalenessMs: 900_000,
      contracts: {
        vault: {
          contractId: VAULT,
          supported: [{ wasmHash: V1, label: 'v1.0.0' }],
        },
      },
    });

    const rules = report.findings.map((f) => f.ruleId);
    expect(rules).toContain('single-rpc-endpoint');
    expect(rules).toContain('localhost-rpc-endpoint');
    expect(rules).toContain('high-poll-interval');
    expect(rules).toContain('wide-staleness-window');
    expect(report.ok).toBe(true);

    const strictReport = auditConfig(
      {
        version: 1,
        network: { rpcUrl: 'http://localhost:8000', passphrase: PASSPHRASE },
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1' }] } },
      },
      { strict: true },
    );
    expect(strictReport.ok).toBe(false);
  });

  it('detects tight-staleness-window, unlabelled-version, duplicate-label, excessive-supported-versions, shared-contract-id, and shared-wasm-hash', () => {
    const report = auditConfig({
      version: 1,
      network: {
        rpcUrl: 'https://primary.stellar-rpc.example.org',
        fallbackRpcUrls: ['https://fallback.stellar-rpc.example.org'],
        passphrase: PASSPHRASE,
      },
      pollIntervalMs: 10_000,
      maxStalenessMs: 20_000,
      contracts: {
        vault: {
          contractId: VAULT,
          supported: [
            { wasmHash: V1, label: 'dup' },
            { wasmHash: V2, label: 'dup' },
            { wasmHash: V3 },
            { wasmHash: V4, label: 'v4' },
          ],
        },
        vault_clone: {
          contractId: VAULT,
          supported: [{ wasmHash: V1, label: 'v1' }],
        },
      },
    });

    const rules = report.findings.map((f) => f.ruleId);
    expect(rules).toContain('tight-staleness-window');
    expect(rules).toContain('unlabelled-version');
    expect(rules).toContain('duplicate-label');
    expect(rules).toContain('excessive-supported-versions');
    expect(rules).toContain('shared-contract-id');
    expect(rules).toContain('shared-wasm-hash');
    expect(report.errorCount).toBe(1);
    expect(report.ok).toBe(false);

    const text = formatAuditReport(report);
    expect(text).toContain('[ERROR] shared-contract-id');
    const tableText = formatAuditReport(report, { table: true });
    expect(tableText).toContain('| SEVERITY');
    expect(tableText).toContain('shared-contract-id');
  });

  it('audits multi-network configs for cross-network-passphrase-collision and cross-network-contract-drift', () => {
    const multi = {
      version: 1,
      networks: {
        testnet: {
          network: {
            rpcUrl: 'https://testnet1.example.org',
            fallbackRpcUrls: ['https://testnet2.example.org'],
            passphrase: PASSPHRASE,
          },
          contracts: {
            vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1' }] },
            pool: { contractId: POOL, supported: [{ wasmHash: V2, label: 'v1' }] },
          },
        },
        staging: {
          network: {
            rpcUrl: 'https://staging1.example.org',
            fallbackRpcUrls: ['https://staging2.example.org'],
            passphrase: PASSPHRASE,
          },
          contracts: {
            vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1' }] },
          },
        },
      },
    };

    const report = auditConfig(multi);
    expect(report.checkedNetworks).toBe(2);
    expect(report.checkedContracts).toBe(3);
    const rules = report.findings.map((f) => f.ruleId);
    expect(rules).toContain('cross-network-passphrase-collision');
    expect(rules).toContain('cross-network-contract-drift');

    // Selecting a single network from multi-network config
    const singleNetReport = auditConfig(multi, { network: 'testnet' });
    expect(singleNetReport.checkedNetworks).toBe(1);
    expect(singleNetReport.checkedContracts).toBe(2);
  });

  it('rejects invalid audit options and mismatched network selectors', () => {
    expect(() => auditConfig(cleanSingleConfig(), { maxSupportedVersions: 0 })).toThrow(ConfigError);
    expect(() => auditConfig(cleanSingleConfig(), { maxRecommendedPollIntervalMs: 0 })).toThrow(ConfigError);
    expect(() => auditConfig(cleanSingleConfig(), { network: 'testnet' })).toThrow(ConfigError);
    expect(() =>
      auditConfig(
        {
          version: 1,
          networks: {
            testnet: {
              network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
              contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
            },
          },
        },
        { network: 'mainnet' },
      ),
    ).toThrow(ConfigError);
  });
});

describe('diffConfigs and formatConfigDiff', () => {
  it('identifies identical configs', () => {
    const diff = diffConfigs(cleanSingleConfig(), cleanSingleConfig());
    expect(diff.identical).toBe(true);
    expect(diff.breaking).toBe(false);
    expect(diff.unchangedContracts).toEqual(['vault']);
    expect(formatConfigDiff(diff)).toBe('Configs are identical.\n');
  });

  it('detects added, removed, and modified contracts, hash rotations, label edits, and network changes', () => {
    const before = {
      version: 1,
      network: {
        rpcUrl: 'https://rpc1.example.org',
        fallbackRpcUrls: ['https://fb-old.example.org'],
        passphrase: PASSPHRASE,
      },
      pollIntervalMs: 15_000,
      maxStalenessMs: 60_000,
      contracts: {
        vault: {
          contractId: VAULT,
          supported: [
            { wasmHash: V1, label: 'v1.0.0' },
            { wasmHash: V2, label: 'v2.0.0-rc' },
          ],
        },
        legacy: {
          contractId: POOL,
          supported: [{ wasmHash: V3, label: 'v1' }],
        },
      },
    };

    const after = {
      version: 1,
      network: {
        rpcUrl: 'https://rpc2.example.org',
        fallbackRpcUrls: ['https://fb-new.example.org'],
        passphrase: 'Public Global Stellar Network ; September 2015',
      },
      pollIntervalMs: 20_000,
      maxStalenessMs: 80_000,
      contracts: {
        vault: {
          contractId: ROUTER,
          supported: [
            { wasmHash: V2, label: 'v2.0.0' },
            { wasmHash: V4, label: 'v3.0.0' },
          ],
        },
        router: {
          contractId: ROUTER,
          supported: [{ wasmHash: V4, label: 'v1' }],
        },
      },
    };

    const diff = diffConfigs(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.breaking).toBe(true);
    expect(diff.addedContracts).toEqual(['router']);
    expect(diff.removedContracts).toEqual(['legacy']);
    expect(diff.modifiedContracts).toEqual(['vault']);
    expect(diff.networkChanges.rpcUrlChanged).toBe(true);
    expect(diff.networkChanges.passphraseChanged).toBe(true);
    expect(diff.networkChanges.addedFallbacks).toEqual(['https://fb-new.example.org']);
    expect(diff.networkChanges.removedFallbacks).toEqual(['https://fb-old.example.org']);
    expect(diff.contracts['vault']?.contractIdChanged).toBe(true);
    expect(diff.contracts['vault']?.addedHashes).toEqual([{ wasmHash: V4, label: 'v3.0.0' }]);
    expect(diff.contracts['vault']?.removedHashes).toEqual([{ wasmHash: V1, label: 'v1.0.0' }]);
    expect(diff.contracts['vault']?.labelChanges).toEqual([
      { wasmHash: V2, beforeLabel: 'v2.0.0-rc', afterLabel: 'v2.0.0' },
    ]);

    const rendered = formatConfigDiff(diff);
    expect(rendered).toContain('[BREAKING]');
    expect(rendered).toContain("+ contract 'router'");
    expect(rendered).toContain("- contract 'legacy'");
    expect(rendered).toContain("~ contract 'vault':");
  });
});

describe('validateUpgradePlan', () => {
  const baseHealth: HealthReport = {
    ok: true,
    network: {
      passphrase: PASSPHRASE,
      verified: true,
      usingFallback: false,
    },
    contracts: {
      vault: {
        contractId: VAULT,
        status: 'supported',
        writable: true,
        liveWasmHash: V1,
        matchedLabel: 'v1.0.0',
        ledgersUntilExpiry: 200_000,
        expiringEntry: 'instance',
        consecutiveErrors: 0,
      },
    },
    checkedAt: 1_000_000,
  };

  it('approves an upgrade plan when target hash is already in supported list and contract is healthy', () => {
    const config = {
      ...cleanSingleConfig(),
      contracts: {
        vault: {
          contractId: VAULT,
          supported: [
            { wasmHash: V1, label: 'v1.0.0' },
            { wasmHash: V2, label: 'v2.0.0' },
          ],
        },
      },
    };
    const plan = validateUpgradePlan(config, baseHealth, [
      { contract: 'vault', targetWasmHash: V2, targetLabel: 'v2.0.0' },
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.contracts['vault']?.inSupportedList).toBe(true);
    expect(plan.contracts['vault']?.alreadyLive).toBe(false);
    expect(plan.contracts['vault']?.canRemoveOldHashes).toEqual([V1]);
  });

  it('blocks an upgrade plan when target hash is not in config, TTL is low, or network is unverified', () => {
    const lowTtlHealth: HealthReport = {
      ...baseHealth,
      network: { ...baseHealth.network, verified: false },
      contracts: {
        vault: {
          contractId: VAULT,
          status: 'supported',
          writable: true,
          liveWasmHash: V1,
          matchedLabel: 'v1.0.0',
          ledgersUntilExpiry: 500,
          expiringEntry: 'code',
          consecutiveErrors: 0,
        },
      },
    };

    const plan = validateUpgradePlan(cleanSingleConfig(), lowTtlHealth, [
      { contract: 'vault', targetWasmHash: V2, targetLabel: 'v2.0.0' },
    ]);
    expect(plan.ready).toBe(false);
    expect(plan.blockers.length).toBeGreaterThanOrEqual(3);
    expect(plan.contracts['vault']?.steps[0]).toContain('wasmward add vault');
  });

  it('validates inputs and rejects empty targets, duplicates, bad hashes, or unknown contracts', () => {
    expect(() => validateUpgradePlan(cleanSingleConfig(), baseHealth, [])).toThrow(ConfigError);
    expect(() =>
      validateUpgradePlan(cleanSingleConfig(), baseHealth, [
        { contract: 'vault', targetWasmHash: V1 },
        { contract: 'vault', targetWasmHash: V2 },
      ]),
    ).toThrow(ConfigError);
    expect(() =>
      validateUpgradePlan(cleanSingleConfig(), baseHealth, [{ contract: 'vault', targetWasmHash: 'not-hex' }]),
    ).toThrow(ConfigError);
    expect(() =>
      validateUpgradePlan(cleanSingleConfig(), baseHealth, [{ contract: 'unknown', targetWasmHash: V1 }]),
    ).toThrow(ConfigError);
  });
});

describe('summarizeHealthReport and formatHealthTable', () => {
  it('summarizes fleet status, lowest TTL, and renders an ASCII health table', () => {
    const report: HealthReport = {
      ok: false,
      network: {
        passphrase: PASSPHRASE,
        verified: true,
        usingFallback: true,
      },
      contracts: {
        vault: {
          contractId: VAULT,
          status: 'supported',
          writable: true,
          liveWasmHash: V1,
          matchedLabel: 'v1.0.0',
          ledgersUntilExpiry: 10_000,
          expiringEntry: 'instance',
          consecutiveErrors: 0,
        },
        pool: {
          contractId: POOL,
          status: 'unsupported',
          writable: false,
          liveWasmHash: V2,
          ledgersUntilExpiry: 500_000,
          expiringEntry: 'code',
          lastError: 'some error',
          consecutiveErrors: 2,
        },
      },
      checkedAt: 2_000_000,
    };

    const summary = summarizeHealthReport(report);
    expect(summary).toEqual({
      ok: false,
      passphrase: PASSPHRASE,
      verified: true,
      usingFallback: true,
      totalContracts: 2,
      writableContracts: 1,
      blockedContracts: 1,
      byStatus: { supported: 1, unsupported: 1 },
      lowestTtlLedgers: 10_000,
      lowestTtlContract: 'vault',
      expiringContracts: ['vault'],
      erroredContracts: ['pool'],
    });

    const table = formatHealthTable(report);
    expect(table).toContain('verified (fallback)');
    expect(table).toContain('| CONTRACT');
    expect(table).toContain('| vault');
    expect(table).toContain('| pool');
    expect(table).toContain('Summary: 1/2 writable, ok=false');
  });
});
