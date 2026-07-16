import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createPlan,
  formatStep,
  hasNativeIosProject,
  parseArgs,
  parseAvailableSimulators,
  selectSimulator,
} from './ios-simulator-browser.mjs';

describe('iOS simulator browser helper', () => {
  it('parses available iOS simulators from simctl JSON', () => {
    const devices = parseAvailableSimulators(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
            {
              name: 'iPhone 18',
              udid: 'SIM-1',
              state: 'Booted',
              isAvailable: true,
            },
            {
              name: 'iPad Pro',
              udid: 'SIM-2',
              state: 'Shutdown',
              availabilityError: 'runtime unavailable',
            },
          ],
        },
      }),
    );

    expect(devices).toEqual([
      expect.objectContaining({
        name: 'iPhone 18',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
        state: 'Booted',
        udid: 'SIM-1',
      }),
    ]);
  });

  it('prefers a booted iPhone and supports explicit UDID selection', () => {
    const devices = [
      { name: 'iPad Pro', udid: 'IPAD', state: 'Booted', runtime: 'iOS', isAvailable: true },
      { name: 'iPhone 18', udid: 'PHONE', state: 'Shutdown', runtime: 'iOS', isAvailable: true },
      { name: 'iPhone 18 Pro', udid: 'BOOTED-PHONE', state: 'Booted', runtime: 'iOS', isAvailable: true },
    ];

    expect(selectSimulator(devices)?.udid).toBe('BOOTED-PHONE');
    expect(selectSimulator(devices, 'PHONE')?.name).toBe('iPhone 18');
    expect(selectSimulator(devices, 'iphone 18 pro')?.udid).toBe('BOOTED-PHONE');
    expect(selectSimulator(devices, 'missing')).toBeNull();
  });

  it('keeps serve-sim cleanup scoped to the selected simulator', () => {
    const simulator = { name: 'iPhone 18', udid: 'SIM-UDID', state: 'Booted', runtime: 'iOS', isAvailable: true };
    const plan = createPlan({
      projectRoot: '/repo/opencode-mobile',
      simulator,
      nativeProjectExists: false,
      noMetro: false,
      skipPrebuild: false,
      skipRun: false,
      serveOnly: false,
    });

    expect(plan.map((step) => step.label)).toEqual([
      'Generate iOS native project',
      'Start Metro bundler',
      'Build and launch app on iOS Simulator',
      'Clear stale scoped simulator mirror',
      'Mirror Simulator into Codex in-app browser',
    ]);
    expect(formatStep(plan[1])).toBe('npx expo start --localhost --port 8081');
    expect(formatStep(plan[2])).toBe('npx expo run:ios --no-bundler --device SIM-UDID');
    expect(formatStep(plan[3])).toBe('npx --yes serve-sim@latest --kill SIM-UDID');
    expect(formatStep(plan[4])).toBe('npx --yes serve-sim@latest SIM-UDID');
  });

  it('can rely on an externally managed Metro process', () => {
    const simulator = { name: 'iPhone 18', udid: 'SIM-UDID', state: 'Booted', runtime: 'iOS', isAvailable: true };
    const plan = createPlan({
      projectRoot: '/repo/opencode-mobile',
      simulator,
      nativeProjectExists: true,
      noMetro: true,
      skipPrebuild: true,
      skipRun: false,
      serveOnly: false,
    });

    expect(plan.map((step) => step.label)).toEqual([
      'Build and launch app on iOS Simulator',
      'Clear stale scoped simulator mirror',
      'Mirror Simulator into Codex in-app browser',
    ]);
    expect(formatStep(plan[0])).toBe('npx expo run:ios --no-bundler --device SIM-UDID');
  });

  it('supports serve-only mode for an app already launched by XcodeBuildMCP', () => {
    const simulator = { name: 'iPhone 18', udid: 'SIM-UDID', state: 'Booted', runtime: 'iOS', isAvailable: true };
    const plan = createPlan({
      projectRoot: '/repo/opencode-mobile',
      simulator,
      nativeProjectExists: true,
      noMetro: false,
      skipPrebuild: true,
      skipRun: true,
      serveOnly: true,
    });

    expect(plan.map((step) => step.label)).toEqual([
      'Clear stale scoped simulator mirror',
      'Mirror Simulator into Codex in-app browser',
    ]);
  });

  it('parses CLI flags used by npm scripts', () => {
    expect(parseArgs(['--doctor']).doctor).toBe(true);
    expect(parseArgs(['--serve-only', '--sim', 'SIM-UDID'])).toMatchObject({
      serveOnly: true,
      skipPrebuild: true,
      skipRun: true,
      simulator: 'SIM-UDID',
    });
    expect(parseArgs(['--no-metro'])).toMatchObject({ noMetro: true });
    expect(parseArgs(['--project-root', 'app']).projectRoot).toBe(path.resolve('app'));
  });

  it('detects native iOS projects from an isolated fixture', () => {
    const fixture = path.join(tmpdir(), `opencode-mobile-ios-${Date.now()}`);
    try {
      mkdirSync(path.join(fixture, 'ios', 'OpenCodeMobile.xcodeproj'), { recursive: true });
      expect(hasNativeIosProject(fixture)).toBe(true);
      expect(hasNativeIosProject(path.join(fixture, 'missing'))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
