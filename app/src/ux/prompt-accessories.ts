export type PromptAccessoryActionId = 'paste' | 'attach';

export interface PromptAccessoryAction {
  id: PromptAccessoryActionId;
  label: string;
  detail: string;
  disabled: boolean;
}

export function createPromptAccessoryModel({
  clipboardText,
  canAttachFiles,
}: {
  prompt: string;
  clipboardText: string | null | undefined;
  canAttachFiles: boolean;
}) {
  const clipboardKnown = clipboardText !== null && clipboardText !== undefined;
  const hasClipboardText = Boolean(clipboardText?.trim());
  return {
    actions: [
      {
        id: 'paste',
        label: 'Paste',
        detail: clipboardKnown ? (hasClipboardText ? 'Insert clipboard text' : 'Paste manually') : 'Read clipboard',
        disabled: false,
      },
      {
        id: 'attach',
        label: 'Attach',
        detail: canAttachFiles ? 'Attach a file reference' : 'File picker unavailable on this surface',
        disabled: !canAttachFiles,
      },
    ] satisfies PromptAccessoryAction[],
  };
}

export function appendClipboardText(prompt: string, clipboardText: string) {
  const trimmedClipboard = clipboardText.trim();
  if (!trimmedClipboard) return prompt;
  const trimmedPrompt = prompt.trimEnd();
  return trimmedPrompt ? `${trimmedPrompt}\n${trimmedClipboard}` : trimmedClipboard;
}

export function enterFileReferenceMode(prompt: string) {
  if (!prompt.trim()) return '@';
  if (/(^|\s)@$/.test(prompt)) return prompt;
  return /\s$/.test(prompt) ? `${prompt}@` : `${prompt} @`;
}
