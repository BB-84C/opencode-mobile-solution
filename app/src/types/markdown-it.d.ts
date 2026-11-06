// markdown-it 10 (pinned by react-native-markdown-display) ships no types.
// Only what this app calls is declared.
declare module 'markdown-it' {
  type Token = { type: string; content: string; markup: string; children: Token[] | null };
  export default class MarkdownIt {
    constructor(options?: { typographer?: boolean; html?: boolean });
    parse(source: string, env: object): Token[];
    render(source: string, env?: object): string;
    renderer: { rules: Record<string, (tokens: Token[], index: number) => string> };
  }
}
