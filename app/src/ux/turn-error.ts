/**
 * Why a turn stopped, from the error object OpenCode records.
 *
 * A failed turn is not output: the server stores `{ name, data: { message } }`
 * on the assistant message (`info.error`) and emits `session.error`. The TUI
 * shows it in a red box; without this the phone and desktop showed nothing and
 * the work just stopped. An abort is the user's own Stop and is not an error.
 */
export interface TurnError {
  aborted: boolean;
  title: string;
  message: string;
}

const TITLES: Record<string, string> = {
  APIError: 'API error',
  ProviderAuthError: 'Provider authentication failed',
  MessageOutputLengthError: 'Output length limit reached',
  ContextOverflowError: 'Context window exceeded',
  ContentFilterError: 'Blocked by the content filter',
  StructuredOutputError: 'Structured output failed',
  UnknownError: 'Error',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Some providers nest their own JSON error inside the message string. */
function unwrapJsonMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = record(JSON.parse(trimmed));
    const inner = parsed?.message ?? record(parsed?.error)?.message;
    return typeof inner === 'string' && inner.trim() ? inner.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

function humanize(name: string) {
  return name.replace(/Error$/, ' error').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** The server appends its own JavaScript stack; it means nothing to the reader. */
function withoutStack(text: string) {
  return text
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line))
    .join('\n')
    .trim();
}

export function describeTurnError(error: unknown): TurnError | null {
  const value = record(error);
  if (!value) return null;
  const name = typeof value.name === 'string' ? value.name : typeof value.type === 'string' ? value.type : 'UnknownError';
  const data = record(value.data);
  const rawMessage = [data?.message, value.message].find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (name === 'MessageAbortedError') return { aborted: true, title: 'Interrupted', message: rawMessage ?? 'Aborted' };
  const status = typeof data?.statusCode === 'number' ? data.statusCode : undefined;
  let effectiveName = name;
  let message = rawMessage ? withoutStack(unwrapJsonMessage(rawMessage)) : '';
  // An error the server did not classify carries its real name in the text:
  // "ProviderModelNotFoundError: Model not found ...".
  const named = /^([A-Z][A-Za-z]*Error):\s*([\s\S]*)$/.exec(message);
  if (named && (name === 'UnknownError' || name === named[1])) {
    effectiveName = named[1];
    message = named[2].trim();
  }
  const base = effectiveName === 'UnknownError' ? TITLES.UnknownError : TITLES[effectiveName] ?? humanize(effectiveName);
  return {
    aborted: false,
    title: status ? `${base} · ${status}` : base,
    message: message || 'The machine reported an error with no description.',
  };
}
