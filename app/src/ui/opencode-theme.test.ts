import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  officialAgentColorCycle,
  officialOpenCodeDefaultTokens,
  officialOpenCodeThemeAssetPaths,
  officialOpenCodeThemeNames,
  resolveOpenCodeMobilePalette,
} from './palette';

describe('official OpenCode TUI theme bridge', () => {
  it('uses official opencode dark tokens as the mobile default palette', () => {
    const palette = resolveOpenCodeMobilePalette('dark');

    expect(palette.background).toBe('#0a0a0a');
    expect(palette.backgroundPanel).toBe('#141414');
    expect(palette.backgroundElement).toBe('#1e1e1e');
    expect(palette.primary).toBe('#fab283');
    expect(palette.secondary).toBe('#5c9cf5');
    expect(palette.text).toBe('#eeeeee');
    expect(palette.panel).toBe(palette.backgroundPanel);
    expect(palette.codeBg).toBe(palette.backgroundElement);
  });

  it('keeps the official built-in TUI theme names available to mobile settings', () => {
    expect(officialOpenCodeThemeNames).toContain('opencode');
    expect(officialOpenCodeThemeNames).toContain('tokyonight');
    expect(officialOpenCodeThemeNames).toContain('catppuccin');
    expect(officialOpenCodeThemeNames).toContain('carbonfox');
    expect(officialOpenCodeThemeNames.length).toBeGreaterThanOrEqual(32);
  });

  it('ships local copies of every official TUI theme asset', () => {
    expect(Object.keys(officialOpenCodeThemeAssetPaths).sort()).toEqual([...officialOpenCodeThemeNames].sort());
    for (const assetPath of Object.values(officialOpenCodeThemeAssetPaths)) {
      expect(existsSync(join(process.cwd(), assetPath))).toBe(true);
    }
  });

  it('mirrors TUI agent color derivation order', () => {
    expect(officialAgentColorCycle).toEqual(['secondary', 'accent', 'success', 'warning', 'primary', 'error', 'info']);
    expect(officialOpenCodeDefaultTokens.dark[officialAgentColorCycle[0]]).toBe('#5c9cf5');
  });
});
