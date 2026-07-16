import { formatModelDisplay } from '@/src/opencode/model-ref';
import type { Agent, Command, FileReference, ProjectGroup, Session } from '@/src/opencode/types';

export interface PromptAssistInput {
  text: string;
  commands: Command[];
  agents: Agent[];
  sessions: Session[];
  workspaces: ProjectGroup[];
  files?: FileReference[];
}

export interface PromptSuggestion {
  id: string;
  label: string;
  detail?: string;
  insertText: string;
}

export function createPromptAssistModel(input: PromptAssistInput) {
  const triggerSpan = findTriggerSpan(input.text);
  if (!triggerSpan) return null;
  const query = input.text.slice(triggerSpan.index + 1).toLowerCase();
  const suggestions =
    triggerSpan.trigger === '/'
      ? slashSuggestions(input.commands, query)
      : referenceSuggestions(input, query);
  return {
    trigger: triggerSpan.trigger,
    query,
    suggestions,
  };
}

export function applyPromptSuggestion(text: string, suggestion: Pick<PromptSuggestion, 'insertText'>) {
  const triggerSpan = findTriggerSpan(text);
  if (!triggerSpan) return `${text}${suggestion.insertText}`;
  return `${text.slice(0, triggerSpan.index)}${suggestion.insertText}`;
}

export function getPromptAssistTrigger(text: string) {
  const triggerSpan = findTriggerSpan(text);
  if (!triggerSpan) return null;
  return {
    trigger: triggerSpan.trigger,
    query: text.slice(triggerSpan.index + 1),
  };
}

function findTriggerSpan(text: string): null | { trigger: '/' | '@'; index: number } {
  const match = text.match(/(^|\s)([\/@])([^\s]*)$/);
  if (!match || match.index === undefined) return null;
  const trigger = match[2] as '/' | '@';
  return {
    trigger,
    index: match.index + match[1].length,
  };
}

function slashSuggestions(commands: Command[], query: string): PromptSuggestion[] {
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .map((command) => ({
      id: `/${command.name}`,
      label: `/${command.name}`,
      detail: command.description,
      insertText: `/${command.name} `,
    }));
}

function referenceSuggestions(input: PromptAssistInput, query: string): PromptSuggestion[] {
  const agents = input.agents
    .filter((agent) => !agent.hidden && agent.name.toLowerCase().startsWith(query))
    .map((agent) => {
      const model = formatModelDisplay(agent.model);
      return {
        id: `agent:${agent.name}`,
        label: `@${agent.name}`,
        detail: model ? `Agent · ${model.detail ? `${model.detail}/` : ''}${model.label}` : 'Agent',
        insertText: `@${agent.name} `,
      };
    });
  const sessions = input.sessions
    .filter((session) => !session.parentID && (session.title ?? session.id).toLowerCase().startsWith(query))
    .map((session) => ({
      id: `session:${session.id}`,
      label: `@${session.title ?? session.id}`,
      detail: session.directory,
      insertText: `@${session.id} `,
    }));
  const workspaces = input.workspaces
    .filter((workspace) => workspace.name.toLowerCase().startsWith(query))
    .map((workspace) => ({
      id: `workspace:${workspace.name}`,
      label: `@${workspace.name}`,
      detail: workspace.directory,
      insertText: `@${workspace.name} `,
    }));
  const files = (input.files ?? [])
    .filter((file) => file.path.toLowerCase().includes(query))
    .map((file) => ({
      id: `file:${file.path}`,
      label: `@${file.path.split(/[\\/]/).filter(Boolean).pop() ?? file.path}`,
      detail: `File · ${file.path}`,
      insertText: `@${file.path} `,
    }));
  return [...agents, ...sessions, ...workspaces, ...files];
}
