import type { Agent, Command, FileReference, ProjectGroup, Session } from '@/src/opencode/types';

import { createPromptAssistModel } from './prompt-assist';

export function createPromptAssistContext({
  prompt,
  commands,
  agents,
  sessions,
  workspaces,
  files,
}: {
  prompt: string;
  commands: Command[];
  agents: Agent[];
  sessions: Session[];
  workspaces: ProjectGroup[];
  files?: FileReference[];
}) {
  return createPromptAssistModel({
    text: prompt,
    commands,
    agents,
    sessions,
    workspaces,
    files,
  });
}
