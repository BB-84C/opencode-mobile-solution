export const appIntentDefinitions = [
  {
    id: 'open-sessions',
    title: 'Open OpenCode Sessions',
    openAppWhenRun: true,
    route: 'opencode://sessions',
  },
] as const;

export type AppIntentHandoff =
  | { type: 'open-sessions' }
  | { type: 'pair-relay'; origin: string; code: string };

export function parseAppIntentUrl(url: string): AppIntentHandoff | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'opencode:') return null;

  if (parsed.hostname === 'sessions' || parsed.hostname === 'workbench') return { type: 'open-sessions' };

  if (parsed.hostname === 'pair') {
    const origin = parsed.searchParams.get('origin') ?? '';
    const code = parsed.searchParams.get('code') ?? '';
    return origin && code ? { type: 'pair-relay', origin, code } : null;
  }

  return null;
}

export function appIntentToRoute(handoff: AppIntentHandoff) {
  if (handoff.type === 'open-sessions') return '/two';
  if (handoff.type === 'pair-relay') {
    return `/pair?origin=${encodeURIComponent(handoff.origin)}&code=${encodeURIComponent(handoff.code)}`;
  }
}

export function redirectAppIntentPath(path: string) {
  const handoff = parseAppIntentUrl(path);
  return handoff ? appIntentToRoute(handoff) : path;
}
