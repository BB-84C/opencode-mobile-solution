import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  addSwiftFileToXcodeProject,
  generateOpenCodeAppIntentsSwift,
  projectNameFromMod,
  writeSwiftFile,
} = require('./withOpenCodeAppIntents');
const appConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'app.json'), 'utf8'));

describe('withOpenCodeAppIntents', () => {
  it('generates the narrow first-pass App Intents surface', () => {
    const swift = generateOpenCodeAppIntentsSwift();

    expect(swift).toContain('struct OpenSessionsIntent: AppIntent');
    expect(swift).not.toContain('DraftPromptIntent');
    expect(swift).not.toContain('SessionEntity');
    expect(swift).toContain('struct OpenCodeMobileShortcuts: AppShortcutsProvider');
  });

  it('generates one discoverable shortcut that cannot create or ambiguously address a session', () => {
    const swift = generateOpenCodeAppIntentsSwift();

    expect(swift.match(/AppShortcut\(/g)).toHaveLength(1);
    expect(swift).toContain('intent: OpenSessionsIntent()');
    expect(swift.match(/systemImageName:/g)).toHaveLength(1);
    expect(swift.match(/\\\(\.applicationName\)/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('hands every native intent to the Expo Router deep-link contract', () => {
    const swift = generateOpenCodeAppIntentsSwift();

    expect(swift).toContain('opencode://sessions');
    expect(swift).not.toContain('opencode://session/');
    expect(swift).not.toContain('opencode://prompt?text=');
    expect(swift).toContain('OpenURLIntent');
    expect(swift).toContain('static let openAppWhenRun = true');
  });

  it('gates OpenURLIntent-backed system entry points to iOS 18 without raising the app deployment target', () => {
    const swift = generateOpenCodeAppIntentsSwift();

    expect(swift.match(/@available\(iOS 18\.0, \*\)/g)).toHaveLength(2);
    expect(swift).toContain('@available(iOS 18.0, *)\nstruct OpenSessionsIntent: AppIntent');
    expect(swift).toContain('@available(iOS 18.0, *)\nstruct OpenCodeMobileShortcuts: AppShortcutsProvider');
  });

  it('does not accept free-form native values that could bypass composite session routing', () => {
    const swift = generateOpenCodeAppIntentsSwift();

    expect(swift).not.toContain('@Parameter');
    expect(swift).not.toContain('addingPercentEncoding');
  });

  it('registers the opencode URL scheme and config plugin for native handoff generation', () => {
    expect(appConfig.expo.scheme).toBe('opencode');
    expect(appConfig.expo.plugins).toContain('./plugins/withOpenCodeAppIntents');
  });

  it('keeps the iOS native envelope configured for simulator and App Store builds', () => {
    expect(appConfig.expo.ios).toMatchObject({
      supportsTablet: true,
      config: {
        usesNonExemptEncryption: false,
      },
    });
    // Deliberately a shape check, not an exact value: each deployment signs with
    // its own id, and pinning one reddens the suite for whoever changes it.
    expect(appConfig.expo.ios.bundleIdentifier).toMatch(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/);
  });

  it('writes the generated Swift file into the iOS app target folder', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-app-intents-'));
    const filePath = writeSwiftFile({ projectRoot, projectName: 'OpenCodeMobile' });

    expect(filePath).toBe(path.join(projectRoot, 'ios', 'OpenCodeMobile', 'OpenCodeAppIntents.swift'));
    expect(fs.readFileSync(filePath, 'utf8')).toContain('struct OpenCodeMobileShortcuts: AppShortcutsProvider');
  });

  it('uses the Expo 57 mod request project name before AppDelegate exists', () => {
    expect(projectNameFromMod({ modRequest: { projectName: 'opencodemobile' } })).toBe('opencodemobile');
    expect(() => projectNameFromMod({ modRequest: {} })).toThrow('iOS project name');
  });

  it('adds the Swift source file to the iOS app target exactly once', () => {
    const project = {
      getFirstTarget: vi.fn(() => ({ uuid: 'APP_TARGET' })),
      hasFile: vi.fn(() => false),
      findPBXGroupKey: vi.fn(({ name }) => (name === 'OpenCodeMobile' ? 'APP_GROUP' : undefined)),
      addSourceFile: vi.fn(),
    };

    addSwiftFileToXcodeProject(project, 'OpenCodeMobile');

    expect(project.addSourceFile).toHaveBeenCalledWith(
      'OpenCodeMobile/OpenCodeAppIntents.swift',
      { target: 'APP_TARGET', lastKnownFileType: 'sourcecode.swift' },
      'APP_GROUP',
    );

    project.hasFile.mockReturnValue(true);
    project.addSourceFile.mockClear();
    addSwiftFileToXcodeProject(project, 'OpenCodeMobile');
    expect(project.addSourceFile).not.toHaveBeenCalled();
  });
});
