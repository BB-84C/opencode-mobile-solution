import { describe, expect, it } from 'vitest';

import { collapseToolOutput, createToolTranscriptModel, shouldRenderTranscriptPart } from './tool-transcript';

describe('TUI-aligned tool transcript presentation', () => {
  it('does not expose raw pending tool payloads in the visible transcript', () => {
    const part = {
      type: 'tool' as const,
      tool: 'apply_patch',
      callID: 'call-secret',
      state: { status: 'pending', input: {}, raw: '{"private":"payload"}' },
    };

    const model = createToolTranscriptModel(part);

    expect(model.title).toBe('Apply patch');
    expect(model.visibleText).toBe('Preparing patch...');
    expect(model.visibleText).not.toContain('call-secret');
    expect(model.visibleText).not.toContain('private');
    expect(model.rawText).toContain('call-secret');
  });

  it('uses semantic command/output text and never falls back to JSON for generic tools', () => {
    expect(
      createToolTranscriptModel({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'npm test' }, output: '32 tests passed' },
      }).visibleText,
    ).toBe('npm test\n32 tests passed');

    expect(
      createToolTranscriptModel({ type: 'tool', tool: 'custom', state: { status: 'running', input: { secret: 123 } } })
        .visibleText,
    ).toBe('Running...');
  });

  it('uses the official shell metadata output, trims it, and strips terminal color controls', () => {
    const model = createToolTranscriptModel({
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'printf hello' },
        metadata: { output: '  \u001b[31mhello\u001b[0m\nworld  ' },
        output: 'model-facing fallback',
      },
    });

    expect(model.shell).toEqual({ command: 'printf hello', output: 'hello\nworld' });
    expect(model.visibleText).toBe('printf hello\nhello\nworld');
  });

  it('matches the official ten-line and Unicode code-point collapse contract', () => {
    const elevenLines = Array.from({ length: 11 }, (_, index) => `line-${index + 1}`).join('\n');
    expect(collapseToolOutput(elevenLines, 10, 1_000)).toEqual({
      output: `${Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n')}\n…`,
      overflow: true,
    });

    expect(collapseToolOutput('😀😀😀😀😀😀', 10, 5)).toEqual({ output: '😀😀😀😀…', overflow: true });

    const exact = Array.from({ length: 10 }, () => 'x').join('\n');
    expect(collapseToolOutput(exact, 10, Array.from(exact).length)).toEqual({ output: exact, overflow: false });
  });

  it('collapses skill, read, todo, and unknown tool payloads to TUI-style semantic summaries', () => {
    expect(
      createToolTranscriptModel({
        type: 'tool',
        tool: 'skill',
        state: { status: 'completed', input: { name: 'receiving-code-review' }, output: '<skill_content>private body</skill_content>' },
      }).visibleText,
    ).toBe('receiving-code-review');
    expect(
      createToolTranscriptModel({
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: 'D:/repo/plan.md' }, output: 'entire private file body' },
      }).visibleText,
    ).toBe('D:/repo/plan.md');
    expect(
      createToolTranscriptModel({
        type: 'tool',
        tool: 'todowrite',
        state: { status: 'completed', input: { todos: [{ content: 'one' }, { content: 'two' }] }, output: 'raw todo JSON' },
      }).visibleText,
    ).toBe('2 todos updated');
    expect(
      createToolTranscriptModel({
        type: 'tool',
        tool: 'custom_internal',
        state: { status: 'completed', input: { secret: 'do not display' }, output: 'private output' },
      }).visibleText,
    ).toBe('Completed');
  });

  it('maps only TUI transcript part types and explicit semantic markers', () => {
    expect(shouldRenderTranscriptPart({ type: 'step-start' } as any)).toBe(false);
    expect(shouldRenderTranscriptPart({ type: 'snapshot' } as any)).toBe(false);
    expect(shouldRenderTranscriptPart({ type: 'text', text: 'answer' })).toBe(true);
    expect(shouldRenderTranscriptPart({ type: 'compaction' } as any)).toBe(true);
    expect(shouldRenderTranscriptPart({ type: 'error', message: 'failed' } as any)).toBe(true);
    expect(shouldRenderTranscriptPart({ type: 'unknown-internal', raw: 'secret' } as any)).toBe(false);
  });
});
