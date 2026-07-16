import type { MessagePart, MessageWithParts, PermissionReply } from '@/src/opencode/types';

const copyControls: Array<'copy' | 'copy-raw' | 'open-text-view'> = ['copy', 'copy-raw', 'open-text-view'];
const inlineTools = new Set(['bash', 'grep', 'read', 'webfetch', 'web_fetch', 'websearch', 'web_search', 'task']);
const blockTools = new Set(['edit', 'applypatch', 'apply_patch', 'write', 'todo', 'question']);

export type PermissionActionId = 'allow-once' | 'allow-always' | 'reject';
export type QuestionPromptMode = 'single' | 'multi' | 'custom' | 'confirm';

export interface QuestionPromptModel {
  id: string;
  title: string;
  mode: QuestionPromptMode;
  options: string[];
  allowCustom: boolean;
  requireConfirmation: boolean;
}

export type QuestionPromptPayload =
  | { questionID: string; answer: string }
  | { questionID: string; answers: string[] }
  | { questionID: string; confirmed: boolean };

export interface QuestionReplyBody {
  answers: string[][];
}

export function getPermissionActions(): Array<{ id: PermissionActionId; label: string }> {
  return [
    { id: 'allow-once', label: 'Allow once' },
    { id: 'allow-always', label: 'Allow always' },
    { id: 'reject', label: 'Reject' },
  ];
}

export function createPermissionReply(action: PermissionActionId, message?: string): PermissionReply {
  if (action === 'allow-once') return { reply: 'once', response: true, remember: false };
  if (action === 'allow-always') return { reply: 'always', response: true, remember: true };
  const trimmed = message?.trim();
  return {
    reply: 'reject',
    response: false,
    remember: false,
    ...(trimmed ? { message: trimmed } : {}),
  };
}

export function getPendingPermissions(messages: MessageWithParts[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      const permission = permissionFromPart(part);
      return permission ? [permission] : [];
    }),
  );
}

export function isPromptBlocked(messages: MessageWithParts[]) {
  return getPendingPermissions(messages).length > 0;
}

export function getQuestionPromptModel(part: MessagePart) {
  const tool = normalizedToolName(part);
  if (part.type !== 'question' && tool !== 'question') return null;

  const record = part as Record<string, unknown>;
  const firstQuestion = firstQuestionRecord(record);
  const questionRecord = firstQuestion ?? record;
  const options = optionLabels(questionRecord.options) ?? arrayOfStrings(questionRecord.choices) ?? [];
  const allowCustom = Boolean(questionRecord.allowCustom ?? questionRecord.custom);
  const requireConfirmation = Boolean(questionRecord.requireConfirmation ?? questionRecord.confirm);
  return {
    id: stringValue(record.id) ?? stringValue(record.questionID) ?? stringValue(record.questionId) ?? 'question',
    title: stringValue(questionRecord.title) ?? stringValue(questionRecord.question) ?? stringValue(questionRecord.header) ?? 'Question',
    mode: questionMode({ options, multiple: Boolean(questionRecord.multiple), allowCustom, requireConfirmation }),
    options,
    allowCustom,
    requireConfirmation,
  } satisfies QuestionPromptModel;
}

export function createQuestionReplyBody(payload: QuestionPromptPayload): QuestionReplyBody {
  if ('answers' in payload) return { answers: [payload.answers] };
  if ('answer' in payload) return { answers: [[payload.answer]] };
  return { answers: [[payload.confirmed ? 'confirmed' : 'rejected']] };
}

export function createQuestionPromptInteraction(model: QuestionPromptModel) {
  const selected = new Set<string>();
  let customAnswer = '';
  let confirmed = false;

  return {
    toggleOption(option: string) {
      if (!model.options.includes(option)) return;
      if (model.mode === 'single') {
        selected.clear();
        selected.add(option);
        return;
      }
      if (selected.has(option)) selected.delete(option);
      else selected.add(option);
    },
    setCustomAnswer(value: string) {
      customAnswer = value;
    },
    setConfirmed(value: boolean) {
      confirmed = value;
    },
    selectedOptions() {
      return model.options.filter((option) => selected.has(option));
    },
    canSubmit() {
      if (model.mode === 'confirm') return confirmed;
      if (model.mode === 'custom') return customAnswer.trim().length > 0;
      if (model.allowCustom && customAnswer.trim().length > 0) return true;
      return selected.size > 0;
    },
    createPayload(): QuestionPromptPayload | null {
      if (model.mode === 'confirm') return confirmed ? { questionID: model.id, confirmed: true } : null;
      if (model.mode === 'custom') {
        const trimmed = customAnswer.trim();
        return trimmed ? { questionID: model.id, answer: trimmed } : null;
      }
      if (model.mode === 'multi') {
        const custom = model.allowCustom && customAnswer.trim() ? [customAnswer.trim()] : [];
        const answers = [...this.selectedOptions(), ...custom];
        return answers.length > 0 ? { questionID: model.id, answers } : null;
      }
      if (model.allowCustom && customAnswer.trim() && selected.size === 0) {
        return { questionID: model.id, answer: customAnswer.trim() };
      }
      const answer = this.selectedOptions()[0];
      return answer ? { questionID: model.id, answer } : null;
    },
  };
}

export function classifyToolPresentation(toolName: string | undefined) {
  const normalized = normalizeToolName(toolName);
  const kind = normalized === 'question' ? 'question' : 'tool';
  const layout = blockTools.has(normalized) ? 'block' : inlineTools.has(normalized) ? 'inline' : 'inline';
  return {
    layout,
    kind,
    copyControls,
  };
}

export function createTextViewModel({ title, text }: { title: string | undefined; text: string }) {
  const trimmedText = text.trim();
  return {
    title: title?.trim() || 'Text view',
    text: trimmedText,
    isEmpty: trimmedText.length === 0,
  };
}

function permissionFromPart(part: MessagePart) {
  const record = part as Record<string, unknown>;
  const type = stringValue(record.type)?.toLowerCase();
  const tool = normalizedToolName(part);
  if (type !== 'permission' && type !== 'approval' && tool !== 'permission') return null;
  const id = stringValue(record.id) ?? stringValue(record.permissionID) ?? stringValue(record.permissionId);
  if (!id) return null;
  return {
    id,
    title: stringValue(record.title) ?? stringValue(record.action) ?? 'Permission required',
    detail: stringValue(record.command) ?? stringValue(record.description),
    blocking: true,
    rejectRequiresGuidance: true,
  };
}

function normalizedToolName(part: MessagePart) {
  return normalizeToolName(stringValue((part as Record<string, unknown>).tool) ?? stringValue((part as Record<string, unknown>).name));
}

function normalizeToolName(toolName: string | undefined) {
  return (toolName ?? '').replace(/[\s-]/g, '_').toLowerCase();
}

function questionMode(input: {
  options: string[];
  multiple: boolean;
  allowCustom: boolean;
  requireConfirmation: boolean;
}): 'single' | 'multi' | 'custom' | 'confirm' {
  if (input.multiple) return 'multi';
  if (input.requireConfirmation && input.options.length <= 1) return 'confirm';
  if (input.allowCustom && input.options.length === 0) return 'custom';
  return 'single';
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function optionLabels(value: unknown) {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  if (!Array.isArray(value)) return undefined;
  const labels = value.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) return stringValue((item as Record<string, unknown>).label);
    return undefined;
  });
  return labels.every((item): item is string => typeof item === 'string') ? labels : undefined;
}

function firstQuestionRecord(record: Record<string, unknown>) {
  const questions = record.questions;
  if (!Array.isArray(questions)) return undefined;
  const first = questions[0];
  return typeof first === 'object' && first !== null && !Array.isArray(first) ? (first as Record<string, unknown>) : undefined;
}
