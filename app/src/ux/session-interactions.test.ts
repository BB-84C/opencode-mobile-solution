import { describe, expect, it } from 'vitest';

import {
  classifyToolPresentation,
  createTextViewModel,
  createPermissionReply,
  createQuestionPromptInteraction,
  getPendingPermissions,
  getPermissionActions,
  getQuestionPromptModel,
  isPromptBlocked,
  createQuestionReplyBody,
} from './session-interactions';
import type { MessageWithParts } from '@/src/opencode/types';

const permissionMessage: MessageWithParts = {
  info: { id: 'm-permission', role: 'assistant' },
  parts: [
    {
      type: 'permission',
      id: 'perm-1',
      title: 'Run command',
      command: 'npm run deploy',
    },
  ],
};

describe('session TUI interaction model', () => {
  it('uses three-way blocking permission prompts', () => {
    const pending = getPendingPermissions([permissionMessage]);

    expect(pending).toEqual([
      expect.objectContaining({
        id: 'perm-1',
        title: 'Run command',
        blocking: true,
        rejectRequiresGuidance: true,
      }),
    ]);
    expect(getPermissionActions().map((action) => action.id)).toEqual(['allow-once', 'allow-always', 'reject']);
    expect(isPromptBlocked([permissionMessage])).toBe(true);
  });

  it('maps permission actions to OpenCode API replies including reject guidance', () => {
    expect(createPermissionReply('allow-once')).toEqual({ reply: 'once' });
    expect(createPermissionReply('allow-always')).toEqual({ reply: 'always' });
    expect(createPermissionReply('reject', 'Use a safer command')).toEqual({
      reply: 'reject',
      message: 'Use a safer command',
    });
  });

  it('models QuestionPrompt as an interactive card, not passive text', () => {
    const question = getQuestionPromptModel({
      type: 'question',
      id: 'q1',
      title: 'Choose files',
      options: ['src/a.ts', 'src/b.ts'],
      multiple: true,
      allowCustom: true,
      requireConfirmation: true,
    });

    expect(question).toEqual({
      id: 'q1',
      title: 'Choose files',
      mode: 'multi',
      options: ['src/a.ts', 'src/b.ts'],
      allowCustom: true,
      requireConfirmation: true,
    });
  });

  it('models OpenAPI-shaped QuestionRequest parts with option labels', () => {
    const question = getQuestionPromptModel({
      type: 'question',
      id: 'que_123',
      questions: [
        {
          header: 'Target',
          question: 'Choose a deployment target',
          options: [
            { label: 'staging', description: 'Deploy to staging' },
            { label: 'production', description: 'Deploy to production' },
          ],
          multiple: false,
          custom: true,
        },
      ],
    });

    expect(question).toEqual({
      id: 'que_123',
      title: 'Choose a deployment target',
      mode: 'single',
      options: ['staging', 'production'],
      allowCustom: true,
      requireConfirmation: false,
    });
  });

  it('tracks single-choice question selection and submit payload', () => {
    const interaction = createQuestionPromptInteraction({
      id: 'q1',
      title: 'Pick one',
      mode: 'single',
      options: ['Alpha', 'Beta'],
      allowCustom: false,
      requireConfirmation: false,
    });

    expect(interaction.canSubmit()).toBe(false);
    interaction.toggleOption('Beta');

    expect(interaction.selectedOptions()).toEqual(['Beta']);
    expect(interaction.canSubmit()).toBe(true);
    expect(interaction.createPayload()).toEqual({ questionID: 'q1', answer: 'Beta' });
  });

  it('tracks multi-choice question selections and submit payload', () => {
    const interaction = createQuestionPromptInteraction({
      id: 'q2',
      title: 'Pick many',
      mode: 'multi',
      options: ['Alpha', 'Beta'],
      allowCustom: false,
      requireConfirmation: false,
    });

    interaction.toggleOption('Alpha');
    interaction.toggleOption('Beta');
    interaction.toggleOption('Alpha');

    expect(interaction.selectedOptions()).toEqual(['Beta']);
    expect(interaction.createPayload()).toEqual({ questionID: 'q2', answers: ['Beta'] });
  });

  it('tracks custom answers and confirmation payloads', () => {
    const custom = createQuestionPromptInteraction({
      id: 'q3',
      title: 'Explain',
      mode: 'custom',
      options: [],
      allowCustom: true,
      requireConfirmation: false,
    });
    custom.setCustomAnswer('  Use readonly mode  ');

    expect(custom.canSubmit()).toBe(true);
    expect(custom.createPayload()).toEqual({ questionID: 'q3', answer: 'Use readonly mode' });

    const confirm = createQuestionPromptInteraction({
      id: 'q4',
      title: 'Continue?',
      mode: 'confirm',
      options: [],
      allowCustom: false,
      requireConfirmation: true,
    });
    confirm.setConfirmed(true);

    expect(confirm.canSubmit()).toBe(true);
    expect(confirm.createPayload()).toEqual({ questionID: 'q4', confirmed: true });
  });

  it('converts local question payloads to OpenCode question reply bodies', () => {
    expect(createQuestionReplyBody({ questionID: 'q1', answer: 'Beta' })).toEqual({ answers: [['Beta']] });
    expect(createQuestionReplyBody({ questionID: 'q2', answers: ['Alpha', 'Beta'] })).toEqual({
      answers: [['Alpha', 'Beta']],
    });
    expect(createQuestionReplyBody({ questionID: 'q3', confirmed: true })).toEqual({ answers: [['confirmed']] });
  });

  it('handles question interaction boundaries', () => {
    const single = createQuestionPromptInteraction({
      id: 'q5',
      title: 'Pick one',
      mode: 'single',
      options: ['Alpha', 'Beta'],
      allowCustom: false,
      requireConfirmation: false,
    });
    single.toggleOption('Alpha');
    single.toggleOption('Beta');
    expect(single.selectedOptions()).toEqual(['Beta']);

    const multi = createQuestionPromptInteraction({
      id: 'q6',
      title: 'Pick many',
      mode: 'multi',
      options: ['Alpha'],
      allowCustom: false,
      requireConfirmation: false,
    });
    expect(multi.canSubmit()).toBe(false);

    const custom = createQuestionPromptInteraction({
      id: 'q7',
      title: 'Other',
      mode: 'custom',
      options: [],
      allowCustom: true,
      requireConfirmation: false,
    });
    custom.setCustomAnswer('   ');
    expect(custom.canSubmit()).toBe(false);

    const confirm = createQuestionPromptInteraction({
      id: 'q8',
      title: 'Continue?',
      mode: 'confirm',
      options: [],
      allowCustom: false,
      requireConfirmation: true,
    });
    expect(confirm.canSubmit()).toBe(false);
  });

  it('allows custom answers when a single-choice question also provides options', () => {
    const interaction = createQuestionPromptInteraction({
      id: 'q9',
      title: 'Pick or explain',
      mode: 'single',
      options: ['Alpha'],
      allowCustom: true,
      requireConfirmation: false,
    });
    interaction.setCustomAnswer('Use another option');

    expect(interaction.canSubmit()).toBe(true);
    expect(interaction.createPayload()).toEqual({ questionID: 'q9', answer: 'Use another option' });
  });

  it.each([
    ['bash', 'inline', 'tool'],
    ['grep', 'inline', 'tool'],
    ['read', 'inline', 'tool'],
    ['webfetch', 'inline', 'tool'],
    ['web_fetch', 'inline', 'tool'],
    ['web-search', 'inline', 'tool'],
    ['web_search', 'inline', 'tool'],
    ['task', 'inline', 'tool'],
    ['edit', 'block', 'tool'],
    ['applypatch', 'block', 'tool'],
    ['apply_patch', 'block', 'tool'],
    ['write', 'block', 'tool'],
    ['todo', 'block', 'tool'],
    ['question', 'block', 'question'],
  ] as const)('renders %s by semantic type with copy fallbacks', (tool, layout, kind) => {
    expect(classifyToolPresentation(tool)).toMatchObject({
      layout,
      kind,
      copyControls: ['copy', 'copy-raw', 'open-text-view'],
    });
  });

  it('creates selectable text-view fallback models for complex output', () => {
    expect(createTextViewModel({ title: 'bash', text: 'npm test\nok' })).toEqual({
      title: 'bash',
      text: 'npm test\nok',
      isEmpty: false,
    });
    expect(createTextViewModel({ title: '', text: '   ' })).toEqual({
      title: 'Text view',
      text: '',
      isEmpty: true,
    });
  });
});
