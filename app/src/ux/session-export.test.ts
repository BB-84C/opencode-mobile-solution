import { describe, expect, it } from 'vitest';

import { createSessionExportArtifact } from './session-export';
import type { MessageWithParts, Session } from '@/src/opencode/types';

describe('session export artifact', () => {
  it('exports structured session metadata and messages instead of plain copy text', () => {
    const session: Session = { id: 's1', title: 'Diagnostics', directory: 'D:/repo' };
    const messages: MessageWithParts[] = [
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'Run diagnostics' }] },
      {
        info: { id: 'm2', role: 'assistant', agent: 'orchestrator', created: '2026-07-09T12:00:00.000Z' },
        parts: [{ type: 'reasoning', text: 'Check logs' }],
      },
    ];

    const artifact = JSON.parse(createSessionExportArtifact({ session, messages }));

    expect(artifact).toMatchObject({
      format: 'opencode-mobile-session-export.v1',
      sessionId: 's1',
      title: 'Diagnostics',
      workspace: 'D:/repo',
      messageCount: 2,
      messages: [
        { id: 'm1', role: 'user', text: 'Run diagnostics' },
        { id: 'm2', role: 'assistant', agent: 'orchestrator', text: 'Check logs' },
      ],
    });
  });
});
