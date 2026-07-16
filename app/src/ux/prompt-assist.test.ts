import { describe, expect, it } from 'vitest';

import { applyPromptSuggestion, createPromptAssistModel, getPromptAssistTrigger } from './prompt-assist';
import type { Agent, Command, FileReference, ProjectGroup, Session } from '@/src/opencode/types';

const commands: Command[] = [
  { name: 'share', description: 'Share current session' },
  { name: 'compact', description: 'Compact context' },
];

const agents: Agent[] = [{ name: 'orchestrator' }, { name: 'project-build' }, { name: 'hidden', hidden: true }];

const sessions: Session[] = [
  { id: 'ses_1', title: 'Fix relay', directory: 'D:\\workspace' },
  { id: 'ses_child', title: 'Build subtask', directory: 'D:\\workspace', parentID: 'ses_1' },
];

const workspaces: ProjectGroup[] = [{ name: 'project', directory: 'D:\\workspace\\project', sessionCount: 3 }];
const files: FileReference[] = [{ path: 'D:\\workspace\\project\\package.json' }];

describe('prompt assist model', () => {
  it('offers slash command autocomplete from server commands', () => {
    const model = createPromptAssistModel({ text: '/sh', commands, agents, sessions, workspaces });

    expect(model).toEqual({
      trigger: '/',
      query: 'sh',
      suggestions: [{ id: '/share', label: '/share', detail: 'Share current session', insertText: '/share ' }],
    });
  });

  it('offers @ references for visible agents, sessions, and workspaces', () => {
    const model = createPromptAssistModel({ text: 'ask @p', commands, agents, sessions, workspaces });

    expect(model?.trigger).toBe('@');
    expect(model?.suggestions.map((suggestion) => suggestion.id)).toEqual(['agent:project-build', 'workspace:project']);
  });

  it('never exposes subagent child sessions as @ references', () => {
    const model = createPromptAssistModel({ text: 'ask @project', commands, agents, sessions, workspaces });

    expect(model?.suggestions.map((suggestion) => suggestion.id)).not.toContain('session:ses_child');
  });

  it('applies suggestions to the active trigger span', () => {
    expect(applyPromptSuggestion('ask @b', { insertText: '@build ' })).toBe('ask @build ');
    expect(applyPromptSuggestion('/sh', { insertText: '/share ' })).toBe('/share ');
  });

  it('offers @ file references and inserts the full path', () => {
    const model = createPromptAssistModel({ text: 'read @pack', commands, agents, sessions, workspaces, files });

    expect(model?.suggestions).toContainEqual({
      id: 'file:D:\\workspace\\project\\package.json',
      label: '@package.json',
      detail: 'File · D:\\workspace\\project\\package.json',
      insertText: '@D:\\workspace\\project\\package.json ',
    });
  });

  it('exposes the active assist trigger for asynchronous reference lookup', () => {
    expect(getPromptAssistTrigger('read @pack')).toEqual({ trigger: '@', query: 'pack' });
    expect(getPromptAssistTrigger('run /share')).toEqual({ trigger: '/', query: 'share' });
    expect(getPromptAssistTrigger('plain text')).toBeNull();
  });
});
