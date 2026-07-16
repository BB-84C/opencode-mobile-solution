import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appConfig = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;

describe('native adaptive layout configuration', () => {
  it('supports rotation while keeping the iOS app in true full-screen mode', () => {
    expect(appConfig.orientation).toBe('default');
    expect(appConfig.ios).toMatchObject({ supportsTablet: true, requireFullScreen: true });
  });

  it('declares the native QR scanner without requesting microphone access', () => {
    expect(appConfig.plugins).toContainEqual([
      'expo-camera',
      {
        cameraPermission: 'Allow OpenCode to scan relay pairing QR codes.',
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ]);
  });
});
