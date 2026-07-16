import { describe, expect, it } from 'vitest';

import { applyQuestionEvent, createQuestionRequestModel, createQuestionSubmission } from './question-request';

const request = {
  id: 'que_123',
  sessionID: 'session-1',
  questions: [
    {
      header: 'Target',
      question: 'Choose one target',
      options: [
        { label: 'staging', description: 'Use the staging host' },
        { label: 'production', description: 'Use the production host' },
      ],
      multiple: false,
      custom: true,
    },
    {
      header: 'Checks',
      question: 'Select all checks',
      options: [
        { label: 'tests', description: 'Run tests' },
        { label: 'lint', description: 'Run lint' },
      ],
      multiple: true,
      custom: false,
    },
  ],
};

describe('official OpenCode question request contract', () => {
  it('preserves every question, option description, mode, custom flag, and confirm tab', () => {
    expect(createQuestionRequestModel(request)).toEqual({
      id: 'que_123',
      sessionID: 'session-1',
      tabs: [
        {
          id: 'question-0',
          header: 'Target',
          question: 'Choose one target',
          options: [
            { label: 'staging', description: 'Use the staging host' },
            { label: 'production', description: 'Use the production host' },
          ],
          multiple: false,
          custom: true,
        },
        {
          id: 'question-1',
          header: 'Checks',
          question: 'Select all checks',
          options: [
            { label: 'tests', description: 'Run tests' },
            { label: 'lint', description: 'Run lint' },
          ],
          multiple: true,
          custom: false,
        },
        { id: 'confirm', header: 'Confirm' },
      ],
      autoSubmitSingleChoice: false,
    });
  });

  it('submits answers in question order as the official two-dimensional payload', () => {
    expect(createQuestionSubmission(request, [['production'], ['tests', 'lint']])).toEqual({
      requestID: 'que_123',
      answers: [['production'], ['tests', 'lint']],
    });
  });

  it('adds asked requests and removes externally replied or rejected requests', () => {
    const asked = applyQuestionEvent({}, { type: 'question.asked', properties: request } as any);
    expect(asked['session-1']).toEqual([request]);

    const replied = applyQuestionEvent(asked, {
      type: 'question.replied',
      properties: { sessionID: 'session-1', requestID: 'que_123', answers: [['production'], ['tests']] },
    } as any);
    expect(replied['session-1']).toEqual([]);

    const rejected = applyQuestionEvent(asked, {
      type: 'question.rejected',
      properties: { sessionID: 'session-1', requestID: 'que_123' },
    } as any);
    expect(rejected['session-1']).toEqual([]);
  });
});
