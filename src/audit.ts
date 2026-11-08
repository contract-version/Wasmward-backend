import { loadConfig, loadConfigDocument, usesPlainHttp, type ConfigDocument } from './config.js';
import { ConfigError } from './errors.js';
import type { HealthReport } from './health.js';
import { describeTimeLeft, EXPIRY_WARNING_LEDGERS } from './state.js';
import type { Status, SupportedVersion, WasmwardConfig } from './types.js';

/** Severity level of an operational or security audit finding. */
export type AuditSeverity = 'error' | 'warning' | 'info';

/** Identifier for each built-in operational/security audit rule. */
export type AuditRuleId =
  | 'single-rpc-endpoint'
  | 'localhost-rpc-endpoint'
  | 'high-poll-interval'
  | 'wide-staleness-window'
  | 'tight-staleness-window'
  | 'unlabelled-version'
  | 'duplicate-label'
  | 'excessive-supported-versions'
  | 'shared-contract-id'
  | 'shared-wasm-hash'
  | 'cross-network-passphrase-collision'
  | 'cross-network-contract-drift';

/** A single finding produced by {@link auditConfig}. */
export interface AuditFinding {
  ruleId: AuditRuleId;
  severity: AuditSeverity;
  path: string;
  message: string;
  remediation: string;
  network?: string | undefined;
  contract?: string | undefined;
}

/** Result of auditing a single-network or multi-network Wasmward configuration. */
export interface AuditReport {
  /** True when `errorCount === 0` (and `warningCount === 0` when `strict: true`). */
  ok: boolean;
  /** Operational readiness score from 0 to 100. */
  score: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: AuditFinding[];
  checkedNetworks: number;
  checkedContracts: number;
}

export interface AuditOptions {
  /** Treat warnings as blocking (`ok: false`). Defaults to `false`. */
  strict?: boolean | undefined;
  /** Audit only the named network in a multi-network config document. */
  network?: string | undefined;
  /** Maximum supported builds per contract before warning about stale legacy versions. Defaults to 3. */
  maxSupportedVersions?: number | undefined;
  /** Maximum poll interval in milliseconds before warning about slow upgrade detection. Defaults to 60000. */
  maxRecommendedPollIntervalMs?: number | undefined;
}

/** Structural difference for a single contract between two configurations. */
export interface ContractDiffChange {
  name: string;
  kind: 'added' | 'removed' | 'modified' | 'unchanged';
  beforeContractId?: string | undefined;
  afterContractId?: string | undefined;
  contractIdChanged: boolean;
  addedHashes: SupportedVersion[];
  removedHashes: SupportedVersion[];
  retainedHashes: SupportedVersion[];
  labelChanges: { wasmHash: string; beforeLabel?: string | undefined; afterLabel?: string | undefined }[];
}

/** Complete structured diff between two single-network `WasmwardConfig` configurations. */
export interface ConfigDiff {
  identical: boolean;
  /** True when a contract was removed, a contractId or passphrase changed, or supported Wasm hashes were dropped. */
  breaking: boolean;
  networkChanges: {
    rpcUrlChanged: boolean;
    beforeRpcUrl: string;
    afterRpcUrl: string;
    passphraseChanged: boolean;
    beforePassphrase: string;
    afterPassphrase: string;
    addedFallbacks: string[];
    removedFallbacks: string[];
    pollIntervalChanged: boolean;
    beforePollIntervalMs: number;
    afterPollIntervalMs: number;
    maxStalenessChanged: boolean;
    beforeMaxStalenessMs: number;
    afterMaxStalenessMs: number;
  };
  contracts: Record<string, ContractDiffChange>;
  addedContracts: string[];
  removedContracts: string[];
  modifiedContracts: string[];
  unchangedContracts: string[];
  summary: string;
}

/** One contract's target Wasm build in an upgrade plan. */
export interface UpgradeTarget {
  contract: string;
  targetWasmHash: string;
  targetLabel?: string | undefined;
}

/** Validation outcome for one contract in a proposed upgrade plan. */
export interface ContractUpgradeValidation {
  contract: string;
  contractId: string;
  targetWasmHash: string;
  targetLabel?: string | undefined;
  ready: boolean;
  alreadyLive: boolean;
  inSupportedList: boolean;
  liveStatus: Status;
  liveWasmHash?: string | undefined;
  canRemoveOldHashes: string[];
  blockers: string[];
  steps: string[];
}

/** Overall validation outcome for a multi-contract upgrade plan. */
export interface UpgradePlanResult {
  ready: boolean;
  contracts: Record<string, ContractUpgradeValidation>;
  blockers: string[];
}

/** Aggregated fleet summary computed from a {@link HealthReport}. */
export interface HealthSummary {
  ok: boolean;
  passphrase: string;
  verified: boolean;
  usingFallback: boolean;
  totalContracts: number;
  writableContracts: number;
  blockedContracts: number;
  byStatus: Partial<Record<Status, number>>;
  lowestTtlLedgers: number | undefined;
  lowestTtlContract: string | undefined;
  expiringContracts: string[];
  erroredContracts: string[];
}

const DEFAULT_MAX_SUPPORTED_VERSIONS = 3;
const DEFAULT_MAX_RECOMMENDED_POLL_MS = 60_000;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

function isConfigDocument(value: unknown): value is ConfigDocument {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'single' || kind === 'multi';
}

function isWasmwardConfig(value: unknown): value is WasmwardConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['version'] === 1 &&
    typeof obj['network'] === 'object' &&
    obj['network'] !== null &&
    typeof obj['pollIntervalMs'] === 'number' &&
    typeof obj['maxStalenessMs'] === 'number' &&
    typeof obj['contracts'] === 'object' &&
    obj['contracts'] !== null &&
    Array.isArray((obj['network'] as Record<string, unknown>)['fallbackRpcUrls'])
  );
}

function prefixPath(networkName: string | undefined, subPath: string): string {
  if (networkName === undefined) return `$${subPath}`;
  return `$.networks.${networkName}${subPath}`;
}

function auditSingleNetwork(
  config: WasmwardConfig,
  networkName: string | undefined,
  maxSupportedVersions: number,
  maxRecommendedPollMs: number,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const withNet = (finding: Omit<AuditFinding, 'network'>): AuditFinding =>
    networkName === undefined ? finding : { ...finding, network: networkName };

  // 1. Single RPC endpoint (no fallback URLs)
  if (config.network.fallbackRpcUrls.length === 0) {
    findings.push(
      withNet({
        ruleId: 'single-rpc-endpoint',
        severity: 'warning',
        path: prefixPath(networkName, '.network.fallbackRpcUrls'),
        message: 'No fallback RPC endpoints are configured; a primary RPC outage will cause contracts to go stale and block writes.',
        remediation: 'Add at least one independent RPC provider URL to network.fallbackRpcUrls.',
      }),
    );
  }

  // 2. Plain HTTP localhost RPC endpoint
  const allUrls = [config.network.rpcUrl, ...config.network.fallbackRpcUrls];
  allUrls.forEach((url, idx) => {
    if (usesPlainHttp(url)) {
      const urlPath = idx === 0 ? '.network.rpcUrl' : `.network.fallbackRpcUrls[${idx - 1}]`;
      findings.push(
        withNet({
          ruleId: 'localhost-rpc-endpoint',
          severity: 'info',
          path: prefixPath(networkName, urlPath),
          message: `RPC endpoint '${url}' uses plain HTTP on localhost; suitable for local testing but not production.`,
          remediation: 'Use an HTTPS RPC endpoint before deploying to staging or production.',
        }),
      );
    }
  });

  // 3. High poll interval
  if (config.pollIntervalMs > maxRecommendedPollMs) {
    findings.push(
      withNet({
        ruleId: 'high-poll-interval',
        severity: 'warning',
        path: prefixPath(networkName, '.pollIntervalMs'),
        message: `pollIntervalMs is ${config.pollIntervalMs}ms (${Math.round(config.pollIntervalMs / 1000)}s), which exceeds the recommended maximum of ${maxRecommendedPollMs}ms (${Math.round(maxRecommendedPollMs / 1000)}s).`,
        remediation: `Reduce pollIntervalMs to ${maxRecommendedPollMs} or lower so contract upgrades are noticed promptly, or use assertWritableFresh for critical writes.`,
      }),
    );
  }

  // 4. Staleness window checks
  if (config.maxStalenessMs > Math.max(300_000, config.pollIntervalMs * 6)) {
    findings.push(
      withNet({
        ruleId: 'wide-staleness-window',
        severity: 'warning',
        path: prefixPath(networkName, '.maxStalenessMs'),
        message: `maxStalenessMs is ${config.maxStalenessMs}ms (${Math.round(config.maxStalenessMs / 1000)}s), allowing cached state to remain writable for a prolonged window during an RPC outage.`,
        remediation: 'Lower maxStalenessMs to 3-4 times pollIntervalMs to bound the stale write window.',
      }),
    );
  } else if (config.maxStalenessMs === config.pollIntervalMs * 2) {
    findings.push(
      withNet({
        ruleId: 'tight-staleness-window',
        severity: 'info',
        path: prefixPath(networkName, '.maxStalenessMs'),
        message: `maxStalenessMs is set to the minimum 2x pollIntervalMs (${config.maxStalenessMs}ms); a single failed poll with jitter may mark contracts stale.`,
        remediation: 'Consider setting maxStalenessMs to 3x or 4x pollIntervalMs for smoother tolerance of transient network blips.',
      }),
    );
  }

  // Track cross-contract IDs and Wasm hashes within this network
  const seenContractIds = new Map<string, string>();
  const seenHashesAcrossContracts = new Map<string, string[]>();

  for (const [contractName, contractCfg] of Object.entries(config.contracts)) {
    const existingContract = seenContractIds.get(contractCfg.contractId);
    if (existingContract !== undefined) {
      findings.push(
        withNet({
          ruleId: 'shared-contract-id',
          severity: 'error',
          path: prefixPath(networkName, `.contracts.${contractName}.contractId`),
          contract: contractName,
          message: `Contract '${contractName}' shares the same contractId (${contractCfg.contractId}) as '${existingContract}'.`,
          remediation: `Assign a distinct contractId to '${contractName}' or remove the duplicate contract entry.`,
        }),
      );
    } else {
      seenContractIds.set(contractCfg.contractId, contractName);
    }

    if (contractCfg.supported.length > maxSupportedVersions) {
      findings.push(
        withNet({
          ruleId: 'excessive-supported-versions',
          severity: 'warning',
          path: prefixPath(networkName, `.contracts.${contractName}.supported`),
          contract: contractName,
          message: `Contract '${contractName}' lists ${contractCfg.supported.length} supported builds (recommended maximum: ${maxSupportedVersions}).`,
          remediation: `Use 'wasmward remove ${contractName} <old-label>' to prune retired Wasm builds after an upgrade completes.`,
        }),
      );
    }

    const labelPositions = new Map<string, number>();
    contractCfg.supported.forEach((version, index) => {
      if (version.label === undefined) {
        findings.push(
          withNet({
            ruleId: 'unlabelled-version',
            severity: 'warning',
            path: prefixPath(networkName, `.contracts.${contractName}.supported[${index}]`),
            contract: contractName,
            message: `Supported build ${version.wasmHash.slice(0, 12)}... on '${contractName}' has no human-readable label.`,
            remediation: `Add a version label (for example "v1.0.0") so logs, health reports, and 'wasmward remove' can identify the build.`,
          }),
        );
      } else {
        const prevIdx = labelPositions.get(version.label);
        if (prevIdx !== undefined) {
          findings.push(
            withNet({
              ruleId: 'duplicate-label',
              severity: 'warning',
              path: prefixPath(networkName, `.contracts.${contractName}.supported[${index}].label`),
              contract: contractName,
              message: `Contract '${contractName}' uses label '${version.label}' on both supported[${prevIdx}] and supported[${index}].`,
              remediation: `Give each supported build of '${contractName}' a unique version label so 'wasmward remove' can address it by label.`,
            }),
          );
        } else {
          labelPositions.set(version.label, index);
        }
      }

      const owners = seenHashesAcrossContracts.get(version.wasmHash);
      if (owners === undefined) {
        seenHashesAcrossContracts.set(version.wasmHash, [contractName]);
      } else if (!owners.includes(contractName)) {
        owners.push(contractName);
      }
    });
  }

  for (const [wasmHash, owners] of seenHashesAcrossContracts) {
    if (owners.length > 1) {
      findings.push(
        withNet({
          ruleId: 'shared-wasm-hash',
          severity: 'info',
          path: prefixPath(networkName, '.contracts'),
          message: `Wasm hash ${wasmHash.slice(0, 12)}... is shared across ${owners.length} contracts (${owners.join(', ')}).`,
          remediation: 'Confirm these contracts intentionally run the same compiled Wasm binary.',
        }),
      );
    }
  }

  return findings;
}

/**
 * Audits a `WasmwardConfig`, `ConfigDocument`, or raw config object for operational, resilience,
 * and security best practices.
 */
export function auditConfig(input: WasmwardConfig | ConfigDocument | unknown, options: AuditOptions = {}): AuditReport {
  const maxSupportedVersions = options.maxSupportedVersions ?? DEFAULT_MAX_SUPPORTED_VERSIONS;
  const maxRecommendedPollMs = options.maxRecommendedPollIntervalMs ?? DEFAULT_MAX_RECOMMENDED_POLL_MS;
  const strict = options.strict === true;

  if (!Number.isInteger(maxSupportedVersions) || maxSupportedVersions < 1) {
    throw new ConfigError(`maxSupportedVersions must be a positive integer, got ${String(maxSupportedVersions)}.`);
  }
  if (!Number.isInteger(maxRecommendedPollMs) || maxRecommendedPollMs < 1) {
    throw new ConfigError(
      `maxRecommendedPollIntervalMs must be a positive integer, got ${String(maxRecommendedPollMs)}.`,
    );
  }

  const document: ConfigDocument = isConfigDocument(input)
    ? input
    : isWasmwardConfig(input)
      ? { kind: 'single', config: input }
      : loadConfigDocument(input);

  const findings: AuditFinding[] = [];
  let checkedNetworks = 0;
  let checkedContracts = 0;

  if (document.kind === 'single') {
    if (options.network !== undefined) {
      throw new ConfigError(
        `This config describes a single network, so network "${options.network}" cannot be chosen.`,
      );
    }
    checkedNetworks = 1;
    checkedContracts = Object.keys(document.config.contracts).length;
    findings.push(
      ...auditSingleNetwork(document.config, undefined, maxSupportedVersions, maxRecommendedPollMs),
    );
  } else {
    const netNames = Object.keys(document.networks);
    if (options.network !== undefined) {
      const target = Object.hasOwn(document.networks, options.network)
        ? document.networks[options.network]
        : undefined;
      if (target === undefined) {
        throw new ConfigError(`Unknown network "${options.network}". This config has: ${netNames.join(', ')}.`);
      }
      checkedNetworks = 1;
      checkedContracts = Object.keys(target.contracts).length;
      findings.push(...auditSingleNetwork(target, options.network, maxSupportedVersions, maxRecommendedPollMs));
    } else {
      const passphrases = new Map<string, string>();
      const allContractNames = new Set<string>();
      for (const netConfig of Object.values(document.networks)) {
        for (const cName of Object.keys(netConfig.contracts)) {
          allContractNames.add(cName);
        }
      }

      for (const [netName, netConfig] of Object.entries(document.networks)) {
        checkedNetworks += 1;
        checkedContracts += Object.keys(netConfig.contracts).length;
        findings.push(...auditSingleNetwork(netConfig, netName, maxSupportedVersions, maxRecommendedPollMs));

        const prevNet = passphrases.get(netConfig.network.passphrase);
        if (prevNet !== undefined) {
          findings.push({
            ruleId: 'cross-network-passphrase-collision',
            severity: 'warning',
            path: `$.networks.${netName}.network.passphrase`,
            network: netName,
            message: `Network '${netName}' has the same network passphrase as '${prevNet}' ("${netConfig.network.passphrase}").`,
            remediation: `Verify that '${netName}' and '${prevNet}' are not accidentally pointing at the same Stellar network.`,
          });
        } else {
          passphrases.set(netConfig.network.passphrase, netName);
        }

        for (const cName of allContractNames) {
          if (!Object.hasOwn(netConfig.contracts, cName)) {
            findings.push({
              ruleId: 'cross-network-contract-drift',
              severity: 'warning',
              path: `$.networks.${netName}.contracts`,
              network: netName,
              contract: cName,
              message: `Contract '${cName}' is defined in other networks of this file but is missing from '${netName}'.`,
              remediation: `Add '${cName}' to $.networks.${netName}.contracts if the app talks to '${cName}' on ${netName}.`,
            });
          }
        }
      }
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const finding of findings) {
    if (finding.severity === 'error') errorCount += 1;
    else if (finding.severity === 'warning') warningCount += 1;
    else infoCount += 1;
  }

  const deduction = errorCount * 35 + warningCount * 10 + infoCount * 2;
  const score = Math.max(0, 100 - deduction);
  const ok = errorCount === 0 && (!strict || warningCount === 0);

  return {
    ok,
    score,
    errorCount,
    warningCount,
    infoCount,
    findings,
    checkedNetworks,
    checkedContracts,
  };
}

function resolveSingleConfig(input: WasmwardConfig | unknown, network?: string): WasmwardConfig {
  if (isWasmwardConfig(input)) {
    if (network !== undefined) {
      throw new ConfigError(`This config describes a single network, so network "${network}" cannot be chosen.`);
    }
    return input;
  }
  return loadConfig(input, network === undefined ? {} : { network });
}

/**
 * Computes a structured diff between two `WasmwardConfig` configurations (or raw config objects).
 */
export function diffConfigs(
  beforeInput: WasmwardConfig | unknown,
  afterInput: WasmwardConfig | unknown,
  options: { network?: string | undefined } = {},
): ConfigDiff {
  const before = resolveSingleConfig(beforeInput, options.network);
  const after = resolveSingleConfig(afterInput, options.network);

  const rpcUrlChanged = before.network.rpcUrl !== after.network.rpcUrl;
  const passphraseChanged = before.network.passphrase !== after.network.passphrase;
  const beforeFallbacks = new Set(before.network.fallbackRpcUrls);
  const afterFallbacks = new Set(after.network.fallbackRpcUrls);
  const addedFallbacks = after.network.fallbackRpcUrls.filter((url) => !beforeFallbacks.has(url));
  const removedFallbacks = before.network.fallbackRpcUrls.filter((url) => !afterFallbacks.has(url));
  const pollIntervalChanged = before.pollIntervalMs !== after.pollIntervalMs;
  const maxStalenessChanged = before.maxStalenessMs !== after.maxStalenessMs;

  const allContractNames = [
    ...new Set([...Object.keys(before.contracts), ...Object.keys(after.contracts)]),
  ].sort();

  const contracts: Record<string, ContractDiffChange> = {};
  const addedContracts: string[] = [];
  const removedContracts: string[] = [];
  const modifiedContracts: string[] = [];
  const unchangedContracts: string[] = [];

  let anyContractBreaking = false;

  for (const name of allContractNames) {
    const prev = before.contracts[name];
    const next = after.contracts[name];

    if (prev === undefined && next !== undefined) {
      addedContracts.push(name);
      contracts[name] = {
        name,
        kind: 'added',
        afterContractId: next.contractId,
        contractIdChanged: false,
        addedHashes: next.supported.map((v) => ({ ...v })),
        removedHashes: [],
        retainedHashes: [],
        labelChanges: [],
      };
      continue;
    }

    if (prev !== undefined && next === undefined) {
      removedContracts.push(name);
      anyContractBreaking = true;
      contracts[name] = {
        name,
        kind: 'removed',
        beforeContractId: prev.contractId,
        contractIdChanged: false,
        addedHashes: [],
        removedHashes: prev.supported.map((v) => ({ ...v })),
        retainedHashes: [],
        labelChanges: [],
      };
      continue;
    }

    if (prev !== undefined && next !== undefined) {
      const contractIdChanged = prev.contractId !== next.contractId;
      const prevByHash = new Map<string, SupportedVersion>(prev.supported.map((v) => [v.wasmHash, v]));
      const nextByHash = new Map<string, SupportedVersion>(next.supported.map((v) => [v.wasmHash, v]));

      const addedHashes = next.supported.filter((v) => !prevByHash.has(v.wasmHash)).map((v) => ({ ...v }));
      const removedHashes = prev.supported.filter((v) => !nextByHash.has(v.wasmHash)).map((v) => ({ ...v }));
      const retainedHashes = next.supported.filter((v) => prevByHash.has(v.wasmHash)).map((v) => ({ ...v }));

      const labelChanges: { wasmHash: string; beforeLabel?: string | undefined; afterLabel?: string | undefined }[] = [];
      for (const version of retainedHashes) {
        const oldVer = prevByHash.get(version.wasmHash);
        if (oldVer !== undefined && oldVer.label !== version.label) {
          labelChanges.push({
            wasmHash: version.wasmHash,
            ...(oldVer.label === undefined ? {} : { beforeLabel: oldVer.label }),
            ...(version.label === undefined ? {} : { afterLabel: version.label }),
          });
        }
      }

      if (contractIdChanged || removedHashes.length > 0) {
        anyContractBreaking = true;
      }

      const modified =
        contractIdChanged ||
        addedHashes.length > 0 ||
        removedHashes.length > 0 ||
        labelChanges.length > 0;

      if (modified) {
        modifiedContracts.push(name);
      } else {
        unchangedContracts.push(name);
      }

      contracts[name] = {
        name,
        kind: modified ? 'modified' : 'unchanged',
        beforeContractId: prev.contractId,
        afterContractId: next.contractId,
        contractIdChanged,
        addedHashes,
        removedHashes,
        retainedHashes,
        labelChanges,
      };
    }
  }

  const networkModified =
    rpcUrlChanged ||
    passphraseChanged ||
    addedFallbacks.length > 0 ||
    removedFallbacks.length > 0 ||
    pollIntervalChanged ||
    maxStalenessChanged;

  const identical =
    !networkModified &&
    addedContracts.length === 0 &&
    removedContracts.length === 0 &&
    modifiedContracts.length === 0;

  const breaking = passphraseChanged || anyContractBreaking;

  const parts: string[] = [];
  if (identical) {
    parts.push('Configs are identical.');
  } else {
    if (addedContracts.length > 0) parts.push(`${addedContracts.length} added`);
    if (removedContracts.length > 0) parts.push(`${removedContracts.length} removed`);
    if (modifiedContracts.length > 0) parts.push(`${modifiedContracts.length} modified`);
    if (unchangedContracts.length > 0) parts.push(`${unchangedContracts.length} unchanged`);
    if (networkModified) parts.push('network settings updated');
  }

  return {
    identical,
    breaking,
    networkChanges: {
      rpcUrlChanged,
      beforeRpcUrl: before.network.rpcUrl,
      afterRpcUrl: after.network.rpcUrl,
      passphraseChanged,
      beforePassphrase: before.network.passphrase,
      afterPassphrase: after.network.passphrase,
      addedFallbacks,
      removedFallbacks,
      pollIntervalChanged,
      beforePollIntervalMs: before.pollIntervalMs,
      afterPollIntervalMs: after.pollIntervalMs,
      maxStalenessChanged,
      beforeMaxStalenessMs: before.maxStalenessMs,
      afterMaxStalenessMs: after.maxStalenessMs,
    },
    contracts,
    addedContracts,
    removedContracts,
    modifiedContracts,
    unchangedContracts,
    summary: identical ? 'Configs are identical.' : `Contracts: ${parts.join(', ')}${breaking ? ' (breaking)' : ''}.`,
  };
}

/**
 * Validates whether a fleet is ready to execute a zero-downtime contract Wasm upgrade plan
 * based on the current `WasmwardConfig` and live `HealthReport`.
 */
export function validateUpgradePlan(
  configInput: WasmwardConfig | unknown,
  health: HealthReport,
  targets: readonly UpgradeTarget[],
): UpgradePlanResult {
  const config = resolveSingleConfig(configInput);
  if (targets.length === 0) {
    throw new ConfigError('validateUpgradePlan requires at least one upgrade target.');
  }

  const globalBlockers: string[] = [];
  if (!health.network.verified) {
    globalBlockers.push('Network has not been verified against the RPC endpoint.');
  }
  if (health.network.passphrase !== config.network.passphrase) {
    globalBlockers.push(
      `Health report passphrase "${health.network.passphrase}" does not match config passphrase "${config.network.passphrase}".`,
    );
  }

  const seenContracts = new Set<string>();
  const contractResults: Record<string, ContractUpgradeValidation> = {};

  for (const target of targets) {
    if (seenContracts.has(target.contract)) {
      throw new ConfigError(`Duplicate upgrade target for contract '${target.contract}'.`);
    }
    seenContracts.add(target.contract);

    if (!HEX_64.test(target.targetWasmHash)) {
      throw new ConfigError(
        `Invalid targetWasmHash for '${target.contract}': must be 64 hex characters, got '${target.targetWasmHash}'.`,
      );
    }
    const normalizedHash = target.targetWasmHash.toLowerCase();
    const contractCfg = Object.hasOwn(config.contracts, target.contract)
      ? config.contracts[target.contract]
      : undefined;
    if (contractCfg === undefined) {
      throw new ConfigError(
        `Unknown contract '${target.contract}'. Configured contracts: ${Object.keys(config.contracts).join(', ')}.`,
      );
    }

    const contractHealth = health.contracts[target.contract];
    const liveStatus: Status = contractHealth?.status ?? 'pending';
    const liveWasmHash = contractHealth?.liveWasmHash;
    const inSupportedList = contractCfg.supported.some((v) => v.wasmHash === normalizedHash);
    const alreadyLive = liveWasmHash === normalizedHash && liveStatus === 'supported';

    const blockers: string[] = [...globalBlockers];
    const steps: string[] = [];

    if (liveStatus !== 'supported') {
      blockers.push(`Contract '${target.contract}' is currently '${liveStatus}', not 'supported'.`);
    }

    if (
      contractHealth?.ledgersUntilExpiry !== undefined &&
      contractHealth.ledgersUntilExpiry < EXPIRY_WARNING_LEDGERS
    ) {
      const which = contractHealth.expiringEntry ?? 'instance';
      blockers.push(
        `Contract '${target.contract}' ${which} TTL is low (${contractHealth.ledgersUntilExpiry} ledgers, ${describeTimeLeft(contractHealth.ledgersUntilExpiry)}); extend TTL before upgrading.`,
      );
    }

    if (!inSupportedList) {
      const labelArg = target.targetLabel ?? 'v-next';
      blockers.push(
        `Target hash ${normalizedHash.slice(0, 12)}... is not yet in '${target.contract}' supported list; deploying it now would block writes.`,
      );
      steps.push(`Add target hash to config first: wasmward add ${target.contract} <build.wasm> --label ${labelArg}`);
      steps.push(`Deploy updated config so all running guards accept both the current and target Wasm hashes.`);
    }

    if (!alreadyLive) {
      steps.push(`Invoke the on-chain upgrade on ${contractCfg.contractId} to switch to ${normalizedHash.slice(0, 12)}...`);
    }

    const canRemoveOldHashes = contractCfg.supported
      .map((v) => v.wasmHash)
      .filter((hash) => hash !== normalizedHash && (!inSupportedList || alreadyLive || hash === liveWasmHash));

    if (alreadyLive && canRemoveOldHashes.length > 0) {
      steps.push(
        `Retire previous supported hashes from '${target.contract}': ${canRemoveOldHashes.map((h) => h.slice(0, 12)).join(', ')}`,
      );
    }

    contractResults[target.contract] = {
      contract: target.contract,
      contractId: contractCfg.contractId,
      targetWasmHash: normalizedHash,
      ...(target.targetLabel === undefined ? {} : { targetLabel: target.targetLabel }),
      ready: blockers.length === 0,
      alreadyLive,
      inSupportedList,
      liveStatus,
      ...(liveWasmHash === undefined ? {} : { liveWasmHash }),
      canRemoveOldHashes,
      blockers,
      steps,
    };
  }

  const allBlockers = [
    ...globalBlockers,
    ...Object.values(contractResults).flatMap((r) => r.blockers.filter((b) => !globalBlockers.includes(b))),
  ];

  return {
    ready: allBlockers.length === 0,
    contracts: contractResults,
    blockers: allBlockers,
  };
}

/**
 * Summarizes a {@link HealthReport} into aggregate counts, status breakdown, and TTL alerts.
 */
export function summarizeHealthReport(
  report: HealthReport,
  options: { warningTtlLedgers?: number | undefined } = {},
): HealthSummary {
  const warningTtlLedgers = options.warningTtlLedgers ?? EXPIRY_WARNING_LEDGERS;
  const entries = Object.entries(report.contracts);
  let writableContracts = 0;
  let blockedContracts = 0;
  const byStatus: Partial<Record<Status, number>> = {};
  let lowestTtlLedgers: number | undefined;
  let lowestTtlContract: string | undefined;
  const expiringContracts: string[] = [];
  const erroredContracts: string[] = [];

  for (const [name, cHealth] of entries) {
    byStatus[cHealth.status] = (byStatus[cHealth.status] ?? 0) + 1;
    if (cHealth.writable) {
      writableContracts += 1;
    } else {
      blockedContracts += 1;
    }
    if (cHealth.consecutiveErrors > 0 || cHealth.lastError !== undefined) {
      erroredContracts.push(name);
    }
    if (cHealth.ledgersUntilExpiry !== undefined) {
      if (lowestTtlLedgers === undefined || cHealth.ledgersUntilExpiry < lowestTtlLedgers) {
        lowestTtlLedgers = cHealth.ledgersUntilExpiry;
        lowestTtlContract = name;
      }
      if (cHealth.ledgersUntilExpiry < warningTtlLedgers) {
        expiringContracts.push(name);
      }
    }
  }

  return {
    ok: report.ok,
    passphrase: report.network.passphrase,
    verified: report.network.verified,
    usingFallback: report.network.usingFallback,
    totalContracts: entries.length,
    writableContracts,
    blockedContracts,
    byStatus,
    lowestTtlLedgers,
    lowestTtlContract,
    expiringContracts: expiringContracts.sort(),
    erroredContracts: erroredContracts.sort(),
  };
}

function renderAsciiTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, colIdx) =>
    Math.max(h.length, ...rows.map((row) => (row[colIdx] ?? '').length)),
  );
  const sep = `+-${widths.map((w) => '-'.repeat(w)).join('-+-')}-+`;
  const formatRow = (cells: readonly string[]): string =>
    `| ${cells.map((cell, idx) => cell.padEnd(widths[idx] ?? cell.length)).join(' | ')} |`;

  const lines = [sep, formatRow(headers), sep];
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  lines.push(sep);
  return lines.join('\n');
}

/**
 * Formats a {@link HealthReport} as an aligned ASCII table for terminal inspection.
 */
export function formatHealthTable(report: HealthReport): string {
  const headers = ['CONTRACT', 'STATUS', 'WRITABLE', 'VERSION', 'WASM HASH', 'TTL LEFT'];
  const rows = Object.entries(report.contracts).map(([name, cHealth]) => {
    const hashShort = cHealth.liveWasmHash !== undefined ? `${cHealth.liveWasmHash.slice(0, 12)}...` : '-';
    const version = cHealth.matchedLabel ?? '-';
    const ttl =
      cHealth.ledgersUntilExpiry !== undefined
        ? `${describeTimeLeft(cHealth.ledgersUntilExpiry)} (${cHealth.expiringEntry ?? 'instance'})`
        : '-';
    return [name, cHealth.status, cHealth.writable ? 'yes' : 'no', version, hashShort, ttl];
  });

  const summary = summarizeHealthReport(report);
  const netStatus = report.network.verified
    ? report.network.usingFallback
      ? 'verified (fallback)'
      : 'verified (primary)'
    : 'unverified';
  const headerLine = `Network: ${report.network.passphrase} [${netStatus}]`;
  const footerLine = `Summary: ${summary.writableContracts}/${summary.totalContracts} writable, ok=${String(report.ok)}`;

  return `${headerLine}\n${renderAsciiTable(headers, rows)}\n${footerLine}\n`;
}

/**
 * Formats an {@link AuditReport} as human-readable text or an aligned ASCII table.
 */
export function formatAuditReport(report: AuditReport, options: { table?: boolean | undefined } = {}): string {
  const header = `Audit score: ${report.score}/100 (${report.errorCount} error(s), ${report.warningCount} warning(s), ${report.infoCount} info) across ${report.checkedNetworks} network(s), ${report.checkedContracts} contract(s).`;
  if (report.findings.length === 0) {
    return `${header}\nNo operational or security issues found.\n`;
  }

  if (options.table === true) {
    const headers = ['SEVERITY', 'RULE', 'PATH', 'MESSAGE'];
    const rows = report.findings.map((f) => [f.severity.toUpperCase(), f.ruleId, f.path, f.message]);
    return `${header}\n${renderAsciiTable(headers, rows)}\n`;
  }

  const lines = [header];
  for (const finding of report.findings) {
    lines.push(
      `  [${finding.severity.toUpperCase()}] ${finding.ruleId} at ${finding.path}: ${finding.message} -> ${finding.remediation}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Formats a {@link ConfigDiff} into a human-readable change summary.
 */
export function formatConfigDiff(diff: ConfigDiff): string {
  if (diff.identical) {
    return `${diff.summary}\n`;
  }
  const lines: string[] = [diff.summary];
  const net = diff.networkChanges;
  if (net.passphraseChanged) {
    lines.push(`  network.passphrase: "${net.beforePassphrase}" -> "${net.afterPassphrase}" [BREAKING]`);
  }
  if (net.rpcUrlChanged) {
    lines.push(`  network.rpcUrl: ${net.beforeRpcUrl} -> ${net.afterRpcUrl}`);
  }
  for (const added of net.addedFallbacks) {
    lines.push(`  + network.fallbackRpcUrls: ${added}`);
  }
  for (const removed of net.removedFallbacks) {
    lines.push(`  - network.fallbackRpcUrls: ${removed}`);
  }
  if (net.pollIntervalChanged) {
    lines.push(`  pollIntervalMs: ${net.beforePollIntervalMs} -> ${net.afterPollIntervalMs}`);
  }
  if (net.maxStalenessChanged) {
    lines.push(`  maxStalenessMs: ${net.beforeMaxStalenessMs} -> ${net.afterMaxStalenessMs}`);
  }

  for (const change of Object.values(diff.contracts)) {
    if (change.kind === 'unchanged') continue;
    if (change.kind === 'added') {
      lines.push(`  + contract '${change.name}' (${change.afterContractId ?? ''}): ${change.addedHashes.length} supported build(s)`);
      continue;
    }
    if (change.kind === 'removed') {
      lines.push(`  - contract '${change.name}' (${change.beforeContractId ?? ''}) [BREAKING]`);
      continue;
    }
    lines.push(`  ~ contract '${change.name}':`);
    if (change.contractIdChanged) {
      lines.push(`      contractId: ${change.beforeContractId ?? ''} -> ${change.afterContractId ?? ''} [BREAKING]`);
    }
    for (const v of change.addedHashes) {
      lines.push(`      + hash ${v.wasmHash}${v.label === undefined ? '' : ` (${v.label})`}`);
    }
    for (const v of change.removedHashes) {
      lines.push(`      - hash ${v.wasmHash}${v.label === undefined ? '' : ` (${v.label})`} [BREAKING]`);
    }
    for (const lc of change.labelChanges) {
      lines.push(`      ~ label on ${lc.wasmHash.slice(0, 12)}...: ${lc.beforeLabel ?? '(none)'} -> ${lc.afterLabel ?? '(none)'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
