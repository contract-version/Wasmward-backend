import { readFile } from 'node:fs/promises';
import { loadConfig, loadConfigDocument, type ConfigDocument } from './config.js';
import { ConfigError } from './errors.js';
import type { WasmwardConfig } from './types.js';

/** Reads and parses a JSON config file. Throws {@link ConfigError} if it is unreadable or not JSON. */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${describe(error)}`);
  }
  try {
    // Windows editors and PowerShell often write a UTF-8 byte order mark, which JSON.parse rejects.
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${describe(error)}`);
  }
}

/**
 * Reads, parses and validates a config file. Node only: this lives behind the
 * `@wasmward/core/node` export path so browser bundles never import `fs`.
 * Throws {@link ConfigError} if the file is unreadable, is not JSON, or fails validation.
 * For a file with a `networks` section, `options.network` says which network to load.
 */
export async function loadConfigFile(path: string, options: { network?: string } = {}): Promise<WasmwardConfig> {
  const json = await readJson(path);
  return loadConfig(json, options.network === undefined ? { source: path } : { source: path, network: options.network });
}

/** Like {@link loadConfigFile}, but returns every network of a multi-network file. */
export async function loadConfigDocumentFile(path: string): Promise<ConfigDocument> {
  return loadConfigDocument(await readJson(path), { source: path });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
