import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ThinkingLevel } from '@/src/ux/tui-actions';

const PROMPT_PREFERENCES_KEY = 'opencode-mobile.promptPreferences.v1';

export interface PromptPreferences {
  activeAgentByHost: Record<string, string>;
  thinkingLevel: ThinkingLevel;
  promptMode: 'ask' | 'shell';
}

const defaults: PromptPreferences = {
  activeAgentByHost: {},
  thinkingLevel: 'high',
  promptMode: 'ask',
};

export async function loadPromptPreferences(): Promise<PromptPreferences> {
  try {
    const raw = await AsyncStorage.getItem(PROMPT_PREFERENCES_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PromptPreferences>;
    return {
      activeAgentByHost: isRecord(parsed.activeAgentByHost) ? (parsed.activeAgentByHost as Record<string, string>) : {},
      thinkingLevel: isThinkingLevel(parsed.thinkingLevel) ? parsed.thinkingLevel : 'high',
      promptMode: parsed.promptMode === 'shell' ? 'shell' : 'ask',
    };
  } catch {
    return defaults;
  }
}

export function savePromptPreferences(preferences: PromptPreferences) {
  return AsyncStorage.setItem(PROMPT_PREFERENCES_KEY, JSON.stringify(preferences));
}

function isRecord(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max';
}
