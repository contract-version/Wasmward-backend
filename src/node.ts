import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import type { WasmwardConfig } from './types.js';

/**
 * Reads, parses and validates a config file. Node only: this lives behind the
 * `@wasmward/core/node` export path so browser bundles never import `fs`.
 * Throws {@link ConfigError} if the file is unreadable, is not JSON, or fails validation.
 */
export async function loadConfigFile(path: string): Promise<WasmwardConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${describe(error)}`);
  }

  let json: unknown;
  try {
    // Windows editors and PowerShell often write a UTF-8 byte order mark, which JSON.parse rejects.
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${describe(error)}`);
  }

  return loadConfig(json, { source: path });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
