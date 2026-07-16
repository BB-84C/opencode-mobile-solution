import { beforeEach, describe, expect, it, vi } from 'vitest';

const backing = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => Promise.resolve(backing.get(key) ?? null)),
  setItem: vi.fn((key: string, value: string) => {
    backing.set(key, value);
    return Promise.resolve();
  }),
};

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

describe('prompt preferences storage', () => {
  beforeEach(() => {
    backing.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('persists the selected agent per host plus variant and prompt mode across reloads', async () => {
    const { loadPromptPreferences, savePromptPreferences } = await import('./prompt-preferences-storage');

    await savePromptPreferences({
      activeAgentByHost: { 'host-a': 'orchestrator' },
      thinkingLevel: 'max',
      promptMode: 'shell',
    });

    await expect(loadPromptPreferences()).resolves.toEqual({
      activeAgentByHost: { 'host-a': 'orchestrator' },
      thinkingLevel: 'max',
      promptMode: 'shell',
    });
  });
});
