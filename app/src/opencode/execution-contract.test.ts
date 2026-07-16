import { describe, expect, it } from 'vitest';

import {
  flattenConfiguredModels,
  resolvePromptSelection,
  variantsForModel,
  type PromptExecutionContract,
} from './execution-contract';
import type { ConfiguredProvidersResponse, MessageWithParts, ProviderModel } from './types';

function model(
  providerID: string,
  id: string,
  options: Partial<ProviderModel> = {},
): ProviderModel {
  return { id, providerID, name: id, ...options };
}

function response(
  providerID: string,
  models: Record<string, ProviderModel>,
  defaultModel?: string,
): ConfiguredProvidersResponse {
  return {
    providers: [{ id: providerID, name: providerID, models }],
    default: defaultModel ? { [providerID]: defaultModel } : {},
  };
}

function contract(
  configuredProviders: ConfiguredProvidersResponse,
  agents: PromptExecutionContract['agents'] = [{ name: 'build', mode: 'primary' }],
): PromptExecutionContract {
  return { agents, configuredProviders };
}

function userMessage(
  agent: string,
  modelSelection: Record<string, unknown>,
): MessageWithParts {
  return {
    info: {
      id: 'message-user',
      role: 'user',
      agent,
      model: modelSelection,
    },
    parts: [{ type: 'text', text: 'continue' }],
  };
}

describe('configured model catalog', () => {
  it('filters deprecated entries and sorts release date descending, then name deterministically', () => {
    const configured = response(
      'openai',
      {
        old: model('openai', 'old', { name: 'Old', release_date: '2026-07-01', status: 'deprecated' }),
        zulu: model('openai', 'zulu', { name: 'Zulu', release_date: '2026-06-01' }),
        beta: model('openai', 'beta', { name: 'Beta', release_date: '2026-07-01' }),
        alpha: model('openai', 'alpha', { name: 'Alpha', release_date: '2026-07-01' }),
        undated: model('openai', 'undated', { name: 'Undated' }),
      },
      'beta',
    );

    expect(flattenConfiguredModels(configured).map((entry) => entry.modelID)).toEqual([
      'alpha',
      'beta',
      'zulu',
      'undated',
    ]);
  });

  it('uses every server variant key and represents Default with undefined', () => {
    const configured = response('openai', {
      reasoning: model('openai', 'reasoning', {
        variants: { minimal: {}, none: {}, xhigh: {} },
      }),
      plain: model('openai', 'plain', { variants: {} }),
    });
    const catalog = flattenConfiguredModels(configured);

    expect(variantsForModel(catalog, { providerID: 'openai', modelID: 'reasoning' })).toEqual([
      undefined,
      'minimal',
      'none',
      'xhigh',
    ]);
    expect(variantsForModel(configured, 'openai/plain')).toEqual([undefined]);
    expect(variantsForModel(catalog, 'openai/missing')).toEqual([]);
  });
});

describe('prompt execution selection', () => {
  it('restores Mac build.model=null from the last user openai/gpt-5.5+xhigh tuple', () => {
    const configured = response(
      'openai',
      {
        'gpt-5.5': model('openai', 'gpt-5.5', { variants: { low: {}, xhigh: {} } }),
      },
      'gpt-5.5',
    );

    expect(
      resolvePromptSelection({
        contract: contract(configured, [{ name: 'build', mode: 'primary', model: null as never }]),
        messages: [userMessage('build', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' })],
      }),
    ).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      variant: 'xhigh',
    });
  });

  it('validates against each machine catalog without leaking a model between machines', () => {
    const mac = contract(
      response('openai', { 'gpt-5.5': model('openai', 'gpt-5.5', { variants: { xhigh: {} } }) }, 'gpt-5.5'),
    );
    const windows = contract(
      response(
        'gauge-forge-anthropic',
        { 'claude-opus-4-8': model('gauge-forge-anthropic', 'claude-opus-4-8', { variants: { high: {} } }) },
        'claude-opus-4-8',
      ),
    );
    const staleMacMessage = userMessage('build', {
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'xhigh',
    });

    expect(resolvePromptSelection({ contract: mac, messages: [staleMacMessage] })).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      variant: 'xhigh',
    });
    expect(resolvePromptSelection({ contract: windows, messages: [staleMacMessage] })).toEqual({
      agentName: 'build',
      model: { providerID: 'gauge-forge-anthropic', modelID: 'claude-opus-4-8' },
    });
  });

  it('ignores invalid cached agent/model/variant and falls back to a current selectable agent and provider default', () => {
    const configured = response(
      'openai',
      {
        deprecated: model('openai', 'deprecated', { status: 'deprecated' }),
        current: model('openai', 'current', { variants: { minimal: {} } }),
      },
      'current',
    );

    expect(
      resolvePromptSelection({
        contract: contract(configured, [
          { name: 'hidden', hidden: true, model: 'openai/deprecated' },
          { name: 'explorer', mode: 'subagent', model: 'openai/deprecated' },
          { name: 'build', mode: 'primary' },
        ]),
        stored: {
          agentName: 'missing-agent',
          model: 'openai/missing',
          variant: 'xhigh',
        },
      }),
    ).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'current' },
    });
  });

  it('clears a stale variant when switching models and accepts a valid variant for the new model', () => {
    const configured = response(
      'openai',
      {
        old: model('openai', 'old', { variants: { xhigh: {} } }),
        next: model('openai', 'next', { variants: { minimal: {}, none: {} } }),
      },
      'old',
    );
    const input = {
      contract: contract(configured),
      messages: [userMessage('build', { providerID: 'openai', modelID: 'old', variant: 'xhigh' })],
    };

    expect(
      resolvePromptSelection({
        ...input,
        override: { model: { providerID: 'openai', modelID: 'next' }, variant: 'xhigh' },
      }),
    ).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'next' },
    });
    expect(
      resolvePromptSelection({
        ...input,
        override: { model: { providerID: 'openai', modelID: 'next' }, variant: 'minimal' },
      }),
    ).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'next' },
      variant: 'minimal',
    });
  });

  it('uses agent, config, and provider defaults only after higher-priority selections are invalid', () => {
    const configured = response(
      'openai',
      {
        agent: model('openai', 'agent', { variants: { none: {} } }),
        config: model('openai', 'config'),
        provider: model('openai', 'provider'),
      },
      'provider',
    );

    expect(
      resolvePromptSelection({
        contract: {
          ...contract(configured, [{ name: 'build', model: 'openai/agent', variant: 'none' }]),
          configModel: 'openai/config',
        },
      }),
    ).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'agent' },
      variant: 'none',
    });
    expect(
      resolvePromptSelection({
        contract: {
          ...contract(configured, [{ name: 'build', model: null as never }]),
          configModel: 'openai/config',
        },
      }),
    ).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'config' },
    });
  });
});
