/**
 * TeX math in markdown, the way models write it.
 *
 * Inline: `$...$` and `\(...\)`. Display: `$$...$$` and `\[...\]`, either as
 * their own block (possibly over several lines) or inside a sentence.
 *
 * A dollar sign is also money, so a single `$` only opens math when the next
 * character is not a space, and only closes it when the previous character is
 * not a space and the next is not a digit (the Pandoc rule). "$5 and $10" stays
 * text. The rules run before markdown's escape and emphasis handling, so `_`
 * and `*` inside a formula never turn into italics.
 *
 * Tokens: `math_inline`, `math_display` (inline position, display style) and
 * `math_block`, each with the TeX source in `content`.
 */

type InlineState = {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): { content: string; markup: string };
};

type BlockState = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  push(type: string, tag: string, nesting: number): { content: string; markup: string; block: boolean; map: [number, number] | null };
};

type MarkdownItLike = {
  inline: { ruler: { before(name: string, rule: string, fn: (state: InlineState, silent: boolean) => boolean): void } };
  block: {
    ruler: {
      before(
        name: string,
        rule: string,
        fn: (state: BlockState, startLine: number, endLine: number, silent: boolean) => boolean,
        options?: { alt: string[] },
      ): void;
    };
  };
};

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';

function findSingleDollarClose(src: string, from: number, max: number) {
  for (let index = from; index < max; index += 1) {
    if (src[index] === '\\') {
      index += 1;
      continue;
    }
    if (src[index] !== '$') continue;
    if (!isSpace(src[index - 1]) && !isDigit(src[index + 1])) return index;
  }
  return -1;
}

function inlineRule(state: InlineState, silent: boolean) {
  const { src, pos, posMax } = state;
  let type: 'math_inline' | 'math_display';
  let content: string;
  let end: number;
  let markup: string;

  if (src.startsWith('\\(', pos) || src.startsWith('\\[', pos)) {
    const close = src[pos + 1] === '(' ? '\\)' : '\\]';
    const at = src.indexOf(close, pos + 2);
    if (at < 0 || at + 2 > posMax) return false;
    content = src.slice(pos + 2, at);
    end = at + 2;
    type = close === '\\)' ? 'math_inline' : 'math_display';
    markup = src.slice(pos, pos + 2);
  } else if (src[pos] === '$' && src[pos + 1] === '$') {
    const at = src.indexOf('$$', pos + 2);
    if (at < 0 || at + 2 > posMax) return false;
    content = src.slice(pos + 2, at);
    end = at + 2;
    type = 'math_display';
    markup = '$$';
  } else if (src[pos] === '$') {
    if (isSpace(src[pos + 1])) return false;
    const at = findSingleDollarClose(src, pos + 1, posMax);
    if (at < 0) return false;
    content = src.slice(pos + 1, at);
    end = at + 1;
    type = 'math_inline';
    markup = '$';
  } else {
    return false;
  }

  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push(type, 'math', 0);
    token.content = content.trim();
    token.markup = markup;
  }
  state.pos = end;
  return true;
}

const BLOCK_DELIMITERS = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
];

function blockRule(state: BlockState, startLine: number, endLine: number, silent: boolean) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineText = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const first = lineText(startLine);
  const delimiter = BLOCK_DELIMITERS.find((candidate) => first.startsWith(candidate.open));
  if (!delimiter) return false;

  const rest = first.slice(delimiter.open.length);
  const parts: string[] = [];
  let lastLine = startLine;

  const restTrimmed = rest.trimEnd();
  if (restTrimmed.length > 0 && restTrimmed.endsWith(delimiter.close)) {
    // The whole formula on one line: `$$ x = 1 $$`. Text after the closing
    // delimiter means it is inline math inside a paragraph instead.
    parts.push(restTrimmed.slice(0, -delimiter.close.length));
  } else {
    if (rest.includes(delimiter.close)) return false;
    if (rest.trim()) parts.push(rest);
    let found = false;
    for (let line = startLine + 1; line < endLine; line += 1) {
      const text = lineText(line).trimEnd();
      if (text.endsWith(delimiter.close)) {
        const before = text.slice(0, -delimiter.close.length);
        if (before.trim()) parts.push(before);
        lastLine = line;
        found = true;
        break;
      }
      parts.push(text);
    }
    if (!found) return false;
  }

  const content = parts.join('\n').trim();
  if (!content) return false;
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content;
  token.markup = delimiter.open;
  token.map = [startLine, lastLine + 1];
  state.line = lastLine + 1;
  return true;
}

export function mathPlugin(md: unknown) {
  const parser = md as MarkdownItLike;
  parser.inline.ruler.before('escape', 'math_inline', inlineRule);
  parser.block.ruler.before('fence', 'math_block', blockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}
