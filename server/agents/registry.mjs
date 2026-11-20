import { AntigravityCliAdapter } from './antigravity.mjs';
import { DirectApiAdapter } from './api-key.mjs';
import { ClaudeCodeCliAdapter } from './claude-code.mjs';
import { CodexCliAdapter } from './codex.mjs';

/**
 * Pluggable registry for AI agent adapters.
 * Registers:
 *   - antigravity: Local Antigravity CLI (`agy`)
 *   - claude:      Local Claude Code CLI (`claude`)
 *   - codex:       Local OpenAI Codex CLI (`codex`)
 *   - api:         Direct API Key (OpenAI / OpenAI-compatible, Anthropic, Gemini)
 */
export class AgentRegistry {
  constructor() {
    this.adapters = new Map();
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

export function createDefaultRegistry({ config, env }) {
  const registry = new AgentRegistry();
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
