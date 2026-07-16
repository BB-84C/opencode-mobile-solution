export type OpenCodeThemeMode = 'dark' | 'light';

export interface OpenCodeThemeTokens {
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  text: string;
  textMuted: string;
  selectedListItemText: string;
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  backgroundMenu: string;
  border: string;
  borderActive: string;
  borderSubtle: string;
  diffAdded: string;
  diffRemoved: string;
  diffContext: string;
  diffHunkHeader: string;
  diffHighlightAdded: string;
  diffHighlightRemoved: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  diffContextBg: string;
  diffLineNumber: string;
  diffAddedLineNumberBg: string;
  diffRemovedLineNumberBg: string;
  markdownText: string;
  markdownHeading: string;
  markdownLink: string;
  markdownLinkText: string;
  markdownCode: string;
  markdownBlockQuote: string;
  markdownEmph: string;
  markdownStrong: string;
  markdownHorizontalRule: string;
  markdownListItem: string;
  markdownListEnumeration: string;
  markdownImage: string;
  markdownImageText: string;
  markdownCodeBlock: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxFunction: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxOperator: string;
  syntaxPunctuation: string;
  thinkingOpacity: number;
}

export interface MobilePalette extends OpenCodeThemeTokens {
  panel: string;
  panelMuted: string;
  blue: string;
  green: string;
  amber: string;
  red: string;
  code: string;
  codeBg: string;
  foregroundOnAccent: string;
  warningBg: string;
  errorBg: string;
  infoBg: string;
  selectedBg: string;
  scrim: string;
}

export const officialOpenCodeThemeNames = [
  'aura',
  'ayu',
  'catppuccin',
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'cobalt2',
  'cursor',
  'dracula',
  'everforest',
  'flexoki',
  'github',
  'gruvbox',
  'kanagawa',
  'material',
  'matrix',
  'mercury',
  'monokai',
  'nightowl',
  'nord',
  'one-dark',
  'osaka-jade',
  'opencode',
  'orng',
  'lucent-orng',
  'palenight',
  'rosepine',
  'solarized',
  'synthwave84',
  'tokyonight',
  'vesper',
  'vercel',
  'zenburn',
  'carbonfox',
] as const;

export type OfficialOpenCodeThemeName = (typeof officialOpenCodeThemeNames)[number];

export const officialOpenCodeDefaultTokens: Record<OpenCodeThemeMode, OpenCodeThemeTokens> = {
  dark: {
    primary: '#fab283',
    secondary: '#5c9cf5',
    accent: '#9d7cd8',
    error: '#e06c75',
    warning: '#f5a742',
    success: '#7fd88f',
    info: '#56b6c2',
    text: '#eeeeee',
    textMuted: '#808080',
    selectedListItemText: '#0a0a0a',
    background: '#0a0a0a',
    backgroundPanel: '#141414',
    backgroundElement: '#1e1e1e',
    backgroundMenu: '#282828',
    border: '#484848',
    borderActive: '#606060',
    borderSubtle: '#3c3c3c',
    diffAdded: '#7fd88f',
    diffRemoved: '#e06c75',
    diffContext: '#808080',
    diffHunkHeader: '#5c9cf5',
    diffHighlightAdded: '#1f3d29',
    diffHighlightRemoved: '#44272b',
    diffAddedBg: '#122318',
    diffRemovedBg: '#2b1719',
    diffContextBg: '#141414',
    diffLineNumber: '#606060',
    diffAddedLineNumberBg: '#1f3d29',
    diffRemovedLineNumberBg: '#44272b',
    markdownText: '#eeeeee',
    markdownHeading: '#fab283',
    markdownLink: '#5c9cf5',
    markdownLinkText: '#5c9cf5',
    markdownCode: '#9d7cd8',
    markdownBlockQuote: '#808080',
    markdownEmph: '#eeeeee',
    markdownStrong: '#eeeeee',
    markdownHorizontalRule: '#484848',
    markdownListItem: '#fab283',
    markdownListEnumeration: '#fab283',
    markdownImage: '#56b6c2',
    markdownImageText: '#56b6c2',
    markdownCodeBlock: '#eeeeee',
    syntaxComment: '#808080',
    syntaxKeyword: '#9d7cd8',
    syntaxFunction: '#5c9cf5',
    syntaxVariable: '#eeeeee',
    syntaxString: '#7fd88f',
    syntaxNumber: '#f5a742',
    syntaxType: '#fab283',
    syntaxOperator: '#e06c75',
    syntaxPunctuation: '#808080',
    thinkingOpacity: 0.65,
  },
  light: {
    primary: '#3b7dd8',
    secondary: '#7b5bb6',
    accent: '#d68c27',
    error: '#d1383d',
    warning: '#d68c27',
    success: '#3d9a57',
    info: '#318795',
    text: '#1a1a1a',
    textMuted: '#8a8a8a',
    selectedListItemText: '#ffffff',
    background: '#ffffff',
    backgroundPanel: '#fafafa',
    backgroundElement: '#f5f5f5',
    backgroundMenu: '#ebebeb',
    border: '#b8b8b8',
    borderActive: '#a0a0a0',
    borderSubtle: '#d4d4d4',
    diffAdded: '#3d9a57',
    diffRemoved: '#d1383d',
    diffContext: '#8a8a8a',
    diffHunkHeader: '#3b7dd8',
    diffHighlightAdded: '#dff3e5',
    diffHighlightRemoved: '#f7dede',
    diffAddedBg: '#edf8f0',
    diffRemovedBg: '#fceded',
    diffContextBg: '#fafafa',
    diffLineNumber: '#a0a0a0',
    diffAddedLineNumberBg: '#dff3e5',
    diffRemovedLineNumberBg: '#f7dede',
    markdownText: '#1a1a1a',
    markdownHeading: '#3b7dd8',
    markdownLink: '#3b7dd8',
    markdownLinkText: '#3b7dd8',
    markdownCode: '#7b5bb6',
    markdownBlockQuote: '#8a8a8a',
    markdownEmph: '#1a1a1a',
    markdownStrong: '#1a1a1a',
    markdownHorizontalRule: '#b8b8b8',
    markdownListItem: '#3b7dd8',
    markdownListEnumeration: '#3b7dd8',
    markdownImage: '#318795',
    markdownImageText: '#318795',
    markdownCodeBlock: '#1a1a1a',
    syntaxComment: '#8a8a8a',
    syntaxKeyword: '#7b5bb6',
    syntaxFunction: '#3b7dd8',
    syntaxVariable: '#1a1a1a',
    syntaxString: '#3d9a57',
    syntaxNumber: '#d68c27',
    syntaxType: '#3b7dd8',
    syntaxOperator: '#d1383d',
    syntaxPunctuation: '#8a8a8a',
    thinkingOpacity: 0.65,
  },
};

export const officialAgentColorCycle = ['secondary', 'accent', 'success', 'warning', 'primary', 'error', 'info'] as const;

export function resolveOpenCodeMobilePalette(mode: OpenCodeThemeMode = 'dark'): MobilePalette {
  const theme = officialOpenCodeDefaultTokens[mode];
  return {
    ...theme,
    panel: theme.backgroundPanel,
    panelMuted: theme.backgroundElement,
    blue: theme.secondary,
    green: theme.success,
    amber: theme.warning,
    red: theme.error,
    code: theme.markdownCodeBlock,
    codeBg: theme.backgroundElement,
    foregroundOnAccent: theme.selectedListItemText,
    warningBg: mode === 'dark' ? '#2a1d0f' : '#fff4dd',
    errorBg: mode === 'dark' ? '#2b1719' : '#fff0f0',
    infoBg: mode === 'dark' ? '#112229' : '#eef8ff',
    selectedBg: mode === 'dark' ? '#1f2f46' : '#eef5ff',
    scrim: mode === 'dark' ? 'rgba(0, 0, 0, 0.58)' : 'rgba(17, 24, 39, 0.28)',
  };
}
