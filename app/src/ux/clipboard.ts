import * as Clipboard from 'expo-clipboard';

export async function writeClipboardText(text: string) {
  const webClipboard = (globalThis.navigator as { clipboard?: { writeText?(value: string): Promise<void> } } | undefined)
    ?.clipboard;
  if (webClipboard?.writeText) {
    await webClipboard.writeText(text);
    return;
  }
  await Clipboard.setStringAsync(text);
}
