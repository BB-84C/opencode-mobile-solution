import { describe, expect, it } from 'vitest';

import type { ConfiguredModelEntry } from '@/src/opencode/execution-contract';

import { filterConfiguredModels } from './model-picker';

const models = [
  entry('openai/gpt-5.5', 'GPT 5.5', 'OpenAI'),
  entry('anthropic/claude-opus-4', 'Claude Opus 4', 'Anthropic'),
];

describe('filterConfiguredModels', () => {
  it('returns the server order when search is empty', () => {
    expect(filterConfiguredModels(models, '')).toEqual(models);
  });

  it('searches provider name, provider id, model name, model id, and full key', () => {
    expect(filterConfiguredModels(models, 'ANTHROPIC')).toEqual([models[1]]);
    expect(filterConfiguredModels(models, 'gpt-5.5')).toEqual([models[0]]);
    expect(filterConfiguredModels(models, 'Claude Opus')).toEqual([models[1]]);
  });
});

function entry(key: string, modelName: string, providerName: string): ConfiguredModelEntry {
  const [providerID, modelID] = key.split('/');
  return {
    key,
    ref: { providerID, modelID },
    providerID,
    providerName,
    modelID,
    modelName,
    model: { id: modelID, providerID, name: modelName },
  };
}
