import { describe, expect, it } from 'vitest';

import {
  buildSessionCreationOptions,
  validateSessionCreation,
  type SessionCreationOptions,
  buildDirectoryChoices,
} from './session-creation';
import type { MachineExecutionContract } from '../opencode/types';

const contract = (over: Partial<MachineExecutionContract> = {}): MachineExecutionContract => ({
  connectionId: 'relay',
  relayTargetID: 'mac',
  relayTargetName: 'mac',
  directory: '/repo',
  agents: [
    { name: 'build', description: 'default agent' },
    { name: 'plan', description: 'read only' },
  ],
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: {
        'claude-opus-5': { id: 'claude-opus-5', providerID: 'anthropic', name: 'Claude Opus 5' },
        'claude-sonnet-5': { id: 'claude-sonnet-5', providerID: 'anthropic', name: 'Claude Sonnet 5' },
      },
    },
  ],
  providerDefaults: { anthropic: 'claude-opus-5' },
  commands: [],
  fetchedAt: '2026-09-16T00:00:00.000Z',
  ...over,
});

const machine = { connectionId: 'relay', targetId: 'mac', targetName: 'mac' };

describe('new session options', () => {
  it('says it has nothing to offer when the machine contract has not arrived', () => {
    // Two empty dropdowns look like the machine has no agents at all.
    const options = buildSessionCreationOptions(undefined);

    expect(options.contractMissing).toBe(true);
    expect(options.agents).toEqual([]);
    expect(options.models).toEqual([]);
  });

  it('offers the agents and models the chosen machine actually has', () => {
    const options = buildSessionCreationOptions(contract());

    expect(options.contractMissing).toBe(false);
    expect(options.agents.map((agent) => agent.name)).toContain('build');
    expect(options.models.length).toBeGreaterThan(0);
    expect(options.models[0].label).toContain('Anthropic');
  });

  it('defaults the directory to the one the machine reported', () => {
    expect(buildSessionCreationOptions(contract()).defaultDirectory).toBe('/repo');
  });

  it('matches the configured default model by its id, not by string equality', () => {
    // The configured default is a bare model id while a picker key carries its
    // provider, so comparing the two strings would never match and the default
    // would silently fall back to whatever happens to be first.
    const options = buildSessionCreationOptions(contract({ configModel: 'claude-sonnet-5' }));
    const chosen = options.models.find((model) => model.key === options.defaultModelKey);

    expect(chosen?.ref.modelID).toBe('claude-sonnet-5');
  });

  it('falls back to the first model when the configured default is not offered here', () => {
    const options = buildSessionCreationOptions(contract({ configModel: 'a-model-this-machine-lacks' }));

    expect(options.defaultModelKey).toBe(options.models[0]?.key);
  });
});

describe('new session validation', () => {
  const options = (): SessionCreationOptions => buildSessionCreationOptions(contract());

  it('refuses without a machine, because a session has to be created somewhere', () => {
    const result = validateSessionCreation({ machine: null }, options());

    expect(result).toEqual({ ok: false, reason: 'Choose a machine first' });
  });

  it('produces both the create call and what has to be applied afterwards', () => {
    // Creation carries the machine and directory only; agent and model are set
    // on the session once it exists. A caller that uses only the first half
    // silently drops the user's choice.
    const result = validateSessionCreation({ machine, agentName: 'plan' }, options());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.create).toMatchObject({ connectionId: 'relay', relayTargetID: 'mac', directory: '/repo' });
    expect(result.plan.apply.agentName).toBe('plan');
    expect(result.plan.apply.model?.modelID).toBe('claude-opus-5');
  });

  it('refuses an agent the chosen machine does not offer', () => {
    const result = validateSessionCreation({ machine, agentName: 'ghost' }, options());

    expect(result).toEqual({ ok: false, reason: 'This machine does not offer the agent "ghost"' });
  });

  it('refuses a model the chosen machine does not offer', () => {
    const result = validateSessionCreation({ machine, modelKey: 'openai/gpt-9' }, options());

    expect(result.ok).toBe(false);
  });

  it('keeps a typed directory and drops a blank one', () => {
    const typed = validateSessionCreation({ machine, directory: '  /other  ' }, options());
    const blank = validateSessionCreation({ machine, directory: '   ' }, options());

    expect(typed.ok && typed.plan.create.directory).toBe('/other');
    // Blank falls back to the machine's own directory rather than sending an
    // empty string the backend would have to interpret.
    expect(blank.ok && blank.plan.create.directory).toBe('/repo');
  });

  it('omits a title rather than sending an empty one', () => {
    const result = validateSessionCreation({ machine, title: '   ' }, options());

    expect(result.ok && 'title' in result.plan.create).toBe(false);
  });
});

describe('directory choices', () => {
  const project = (directory: string, sessionCount: number, relayTargetID?: string) =>
    ({ directory, sessionCount, relayTargetID });

  it('puts the machine default first, so an empty field has a visible meaning', () => {
    // Typing an absolute path on a phone is the problem this solves: leaving the
    // field empty already uses the machine default, but nothing said so.
    const choices = buildDirectoryChoices({
      projects: [project('/Users/me/work', 4)],
      defaultDirectory: '/Users/me',
      current: '',
    });

    expect(choices[0].directory).toBe('/Users/me');
    expect(choices[0].isDefault).toBe(true);
    expect(choices[0].selected).toBe(true);
    expect(choices[0].detail).toContain('machine default');
  });

  it('offers the directories the machine already has sessions in, busiest first', () => {
    const choices = buildDirectoryChoices({
      projects: [project('/a', 1), project('/b', 9), project('/c', 3)],
      current: '',
    });

    expect(choices.map((choice) => choice.directory)).toEqual(['/b', '/c', '/a']);
  });

  it('shows the folder name, because that is what a person recognises', () => {
    const [choice] = buildDirectoryChoices({
      projects: [project('/Users/me/Documents/essay draft', 2)],
      current: '',
    });

    expect(choice.label).toBe('essay draft');
    expect(choice.detail).toContain('/Users/me/Documents/essay draft');
  });

  it('never lists the same directory twice, even when it is also the default', () => {
    const choices = buildDirectoryChoices({
      projects: [project('/Users/me', 7)],
      defaultDirectory: '/Users/me',
      current: '',
    });

    expect(choices).toHaveLength(1);
    expect(choices[0].detail).toContain('7 sessions');
  });

  it('leaves out directories belonging to another machine', () => {
    const choices = buildDirectoryChoices({
      projects: [project('/mine', 2, 'mac'), project('/theirs', 5, 'windows')],
      targetId: 'mac',
      current: '',
    });

    expect(choices.map((choice) => choice.directory)).toEqual(['/mine']);
  });

  it('marks whichever directory is currently entered', () => {
    const choices = buildDirectoryChoices({
      projects: [project('/a', 1), project('/b', 2)],
      current: '/a',
    });

    expect(choices.find((choice) => choice.directory === '/a')?.selected).toBe(true);
    expect(choices.find((choice) => choice.directory === '/b')?.selected).toBe(false);
  });
});
