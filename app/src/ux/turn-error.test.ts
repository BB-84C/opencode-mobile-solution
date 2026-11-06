import { describe, expect, it } from 'vitest';

import { describeTurnError } from './turn-error';

describe('describeTurnError', () => {
  it('names an API error with its status code and message', () => {
    expect(describeTurnError({
      name: 'APIError',
      data: { message: 'Internal Server Error: No available Claude accounts support the requested model: claude-opus-5-5', statusCode: 500, isRetryable: true },
    })).toEqual({
      aborted: false,
      title: 'API error · 500',
      message: 'Internal Server Error: No available Claude accounts support the requested model: claude-opus-5-5',
    });
  });

  it('treats an abort as an interruption, not an error', () => {
    expect(describeTurnError({ name: 'MessageAbortedError', data: { message: 'Aborted' } })).toMatchObject({ aborted: true });
  });

  it('unwraps a provider JSON payload inside the message', () => {
    expect(describeTurnError({ name: 'UnknownError', data: { message: '{"type":"api_error","message":"Connection reset by Claude API server"}' } }))
      .toEqual({ aborted: false, title: 'Error', message: 'Connection reset by Claude API server' });
  });

  it('still says something for an unknown shape, and nothing for no error', () => {
    expect(describeTurnError({ name: 'WeirdNewError' })).toEqual({
      aborted: false,
      title: 'Weird New error',
      message: 'The machine reported an error with no description.',
    });
    expect(describeTurnError(undefined)).toBeNull();
  });

  it('drops the server stack trace and names the error the message starts with', () => {
    const message = [
      'ProviderModelNotFoundError: Model not found: anthropic-hairen/claude-x. Did you mean: claude-fable-5?',
      '    at <anonymous> (/$bunfs/root/chunk-qmajxhps.js:439:94601)',
      '    at SessionPrompt.getModel (/$bunfs/root/chunk-y4f911v7.js:1142:11505)',
    ].join('\n');
    expect(describeTurnError({ name: 'UnknownError', data: { message } })).toEqual({
      aborted: false,
      title: 'Provider Model Not Found error',
      message: 'Model not found: anthropic-hairen/claude-x. Did you mean: claude-fable-5?',
    });
  });
});
