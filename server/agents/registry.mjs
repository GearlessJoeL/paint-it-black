import { AntigravityCliAdapter } from './antigravity.mjs';

/**
 * Pluggable registry for local AI agent adapters.
 * Currently registers Antigravity CLI (`agy`) in WSL; additional local CLI agents
 * (e.g., Claude Code, Codex) can be added by implementing the same adapter contract:
 *   - id, label, description
 *   - async checkStatus()
 *   - async runStructuredPrompt({ prompt, schema, model, effort, cwd, conversationId, signal, onEvent })
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
}

export function createDefaultRegistry({ config, env }) {
  const registry = new AgentRegistry();
  registry.register(
    new AntigravityCliAdapter({
      binaryPath: config.agyBin,
      env,
    }),
  );
  return registry;
}
