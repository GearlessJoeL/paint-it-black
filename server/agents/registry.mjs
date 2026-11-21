import path from 'node:path';
import { AntigravityCliAdapter } from './antigravity.mjs';
import { DirectApiAdapter } from './api-key.mjs';
import { ClaudeCodeCliAdapter } from './claude-code.mjs';
import { CodexCliAdapter } from './codex.mjs';
import { buildToolEnv, loadConfig } from '../config.mjs';

/**
 * Pluggable registry for AI agent adapters.
 * Registers:
 *   - antigravity: Local Antigravity CLI (`agy`)
 *   - claude:      Local Claude Code CLI (`claude`)
 *   - codex:       Local OpenAI Codex CLI (`codex`)
 *   - api:         Direct API Key (OpenAI / OpenAI-compatible, Anthropic, Gemini)
 */
export class AgentRegistry {
  constructor({ refreshToolPaths } = {}) {
    this.adapters = new Map();
    this.refreshToolPaths = refreshToolPaths;
  }

  register(adapter) {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id) {
    return this.adapters.get(id) || null;
  }

  list() {
    return [...this.adapters.values()];
  }

  async checkAllStatuses({ forceRefresh = false } = {}) {
    this.refreshToolPaths?.(this);
    const results = await Promise.all(
      this.list().map(async (adapter) => {
        try {
          return await adapter.checkStatus({ forceRefresh });
        } catch (err) {
          return {
            id: adapter.id,
            label: adapter.label,
            description: adapter.description,
            installed: false,
            authenticated: false,
            models: [],
            message: err.message,
          };
        }
      }),
    );
    return results;
  }

  disposeAll() {
    for (const adapter of this.list()) {
      adapter.dispose?.();
    }
  }

  resetAll() {
    for (const adapter of this.list()) {
      if (typeof adapter.reset === 'function') {
        adapter.reset();
      } else {
        adapter.dispose?.();
        adapter.invalidateStatusCache?.();
      }
    }
  }
}

export function createDefaultRegistry({ config, env, resolveConfig = () => loadConfig(config) }) {
  const registry = new AgentRegistry({
    refreshToolPaths(registry) {
      // A CLI may be installed or moved while the companion keeps running.
      // Reuse startup overrides, but recheck their existence and search again.
      const discovered = resolveConfig();
      const discoveredEnv = buildToolEnv(discovered);
      const toolEnv = {
        ...env,
        PATH: [...new Set([
          ...discovered.extraPathDirs,
          ...(env.PATH || discoveredEnv.PATH || '').split(path.delimiter),
        ])].filter(Boolean).join(path.delimiter),
      };
      for (const [id, key] of [['antigravity', 'agyBin'], ['claude', 'claudeBin'], ['codex', 'codexBin']]) {
        const adapter = registry.get(id);
        if (adapter.binaryPath !== discovered[key]) {
          if (adapter.reset) adapter.reset();
          else {
            adapter.dispose?.();
            adapter.invalidateStatusCache?.();
          }
          adapter.binaryPath = discovered[key];
        }
        adapter.env = toolEnv;
      }
    },
  });
  registry.register(
    new AntigravityCliAdapter({
      binaryPath: config.agyBin,
      env,
    }),
  );
  registry.register(
    new ClaudeCodeCliAdapter({
      binaryPath: config.claudeBin,
      env,
    }),
  );
  registry.register(
    new CodexCliAdapter({
      binaryPath: config.codexBin,
      env,
    }),
  );
  registry.register(
    new DirectApiAdapter({
      env,
      apiDefaults: config.apiDefaults,
    }),
  );
  return registry;
}
