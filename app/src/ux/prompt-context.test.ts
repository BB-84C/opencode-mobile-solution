import { describe, expect, it } from 'vitest';

import { createPromptAssistContext } from './prompt-context';
import type { Agent, Command, ProjectGroup, Session } from '@/src/opencode/types';

describe('prompt assist context', () => {
  it('keeps workspace references available inside session prompt assist', () => {
    const sessions: Session[] = [{ id: 'ses_1', title: 'Fix relay', directory: 'D:\\workspace' }];
    const workspaces: ProjectGroup[] = [{ name: 'project', directory: 'D:\\workspace\\project', sessionCount: 2 }];
    const agents: Agent[] = [{ name: 'orchestrator' }];
    const commands: Command[] = [{ name: 'compact', description: 'Compact context' }];

    const context = createPromptAssistContext({
      prompt: 'ask @p',
      commands,
      agents,
      sessions,
      workspaces,
    });

    expect(context?.trigger).toBe('@');
    expect(context?.suggestions.map((suggestion) => suggestion.id)).toContain('workspace:project');
  });
});
