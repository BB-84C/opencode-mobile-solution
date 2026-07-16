export type ServerEvent = { type: string; [key: string]: unknown };

export function createSseParser(onEvent: (event: ServerEvent) => void) {
  let buffer = '';

  function parseFrame(frame: string) {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }

    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      onEvent({ type: eventName, ...payload });
    } catch {
      onEvent({ type: eventName, data: raw });
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) parseFrame(frame);
    },
    flush() {
      if (!buffer.trim()) return;
      parseFrame(buffer);
      buffer = '';
    },
  };
}
