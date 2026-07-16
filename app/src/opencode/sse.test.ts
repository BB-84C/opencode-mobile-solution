import { describe, expect, it } from 'vitest';

import { createSseParser } from './sse';

describe('createSseParser', () => {
  it('parses split server-sent events and preserves event names', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('event: server.connected\ndata: {"version":"1.17.14"}\n');
    parser.push('\nevent: message.part.updated\ndata: {"properties":{"part":{"type":"text"}}}\n\n');

    expect(events).toEqual([
      { type: 'server.connected', version: '1.17.14' },
      { type: 'message.part.updated', properties: { part: { type: 'text' } } },
    ]);
  });

  it('joins multiline data fields before parsing JSON', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('event: message.updated\n');
    parser.push('data: {"id":"a",\n');
    parser.push('data: "role":"assistant"}\n\n');

    expect(events).toEqual([{ type: 'message.updated', id: 'a', role: 'assistant' }]);
  });
});
