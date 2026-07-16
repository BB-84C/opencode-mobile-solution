import { redirectAppIntentPath } from '@/src/ux/app-intents';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return redirectAppIntentPath(path);
}
