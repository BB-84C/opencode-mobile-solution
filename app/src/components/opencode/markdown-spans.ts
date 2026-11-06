import MarkdownIt from 'markdown-it';

/**
 * Markdown flattened into one run of styled text.
 *
 * iOS can only select a range inside a single text view. Rendering a message
 * as separate blocks (one per paragraph, list item and code block) left every
 * selection trapped in the block it started in, so the phone gets the whole
 * message as one string instead: block structure becomes newlines, list
 * markers and quote bars, and only character styles survive as attributes.
 */
export type SpanKind =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'strong'
  | 'em'
  | 's'
  | 'code'
  | 'codeBlock'
  | 'link'
  | 'quote'
  | 'muted';

export type Span = { text: string; kinds: SpanKind[]; href?: string };

type Token = {
  type: string;
  tag: string;
  content: string;
  attrs: [string, string][] | null;
  children: Token[] | null;
};

// Same options react-native-markdown-display uses, so both renderers agree on
// what the source means.
const parser = new MarkdownIt({ typographer: true });

const QUOTE_BAR = '│ ';
const CELL_GAP = ' │ ';
const RULE = '────────';
const LIST_INDENT = '    ';

function attr(token: Token, name: string) {
  return token.attrs?.find(([key]) => key === name)?.[1];
}

export function markdownToSpans(source: string): Span[] {
  if (!source.trim()) return [];
  const tokens = parser.parse(source, {}) as unknown as Token[];

  const spans: Span[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  const inline: SpanKind[] = [];
  let href: string | undefined;
  let heading: SpanKind | null = null;
  let quoteDepth = 0;
  let pendingNewlines = 0;
  let lineStart = true;
  let listMarker: string | null = null;
  // The first block inside a list item or quote sits on the marker's line.
  let fresh = false;
  let cellIndex = 0;
  let rowIndex = 0;

  const push = (text: string, kinds: SpanKind[], link?: string) => {
    const last = spans[spans.length - 1];
    if (last && last.href === link && last.kinds.join() === kinds.join()) last.text += text;
    else spans.push(link ? { text, kinds, href: link } : { text, kinds });
  };

  const emit = (text: string, extra: SpanKind[] = []) => {
    if (!text) return;
    if (spans.length > 0 && pendingNewlines > 0) {
      push('\n'.repeat(pendingNewlines), []);
      lineStart = true;
    }
    pendingNewlines = 0;
    if (lineStart) {
      if (listMarker !== null) {
        push(listMarker, []);
        listMarker = null;
      } else if (lists.length > 0) {
        push(LIST_INDENT.repeat(lists.length), []);
      }
      if (quoteDepth > 0) push(QUOTE_BAR.repeat(quoteDepth), ['quote']);
      lineStart = false;
    }
    const kinds = [...(heading ? [heading] : []), ...(quoteDepth > 0 ? (['quote'] as SpanKind[]) : []), ...inline, ...extra];
    push(text, kinds, href);
  };

  const newline = () => {
    emit('\n');
    lineStart = true;
  };

  const startBlock = () => {
    if (fresh) {
      fresh = false;
      return;
    }
    pendingNewlines = Math.max(pendingNewlines, lists.length > 0 ? 1 : 2);
  };

  const inlineTokens = (children: Token[]) => {
    for (const child of children) {
      switch (child.type) {
        case 'text':
        case 'html_inline':
          emit(child.content);
          break;
        case 'code_inline':
          emit(child.content, ['code']);
          break;
        case 'softbreak':
        case 'hardbreak':
          newline();
          break;
        case 'strong_open':
          inline.push('strong');
          break;
        case 'em_open':
          inline.push('em');
          break;
        case 's_open':
          inline.push('s');
          break;
        case 'link_open':
          inline.push('link');
          href = attr(child, 'href');
          break;
        case 'strong_close':
        case 'em_close':
        case 's_close':
          inline.pop();
          break;
        case 'link_close':
          inline.pop();
          href = undefined;
          break;
        case 'image':
          emit(`[image: ${child.content || attr(child, 'alt') || ''}]`, ['muted']);
          break;
        default:
          break;
      }
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading_open':
        startBlock();
        heading = token.tag === 'h1' ? 'heading1' : token.tag === 'h2' ? 'heading2' : 'heading3';
        break;
      case 'heading_close':
        heading = null;
        break;
      case 'paragraph_open':
        startBlock();
        break;
      case 'bullet_list_open':
      case 'ordered_list_open':
        if (!fresh) pendingNewlines = Math.max(pendingNewlines, lists.length > 0 ? 1 : 2);
        fresh = false;
        lists.push({ ordered: token.type === 'ordered_list_open', next: Number(attr(token, 'start') ?? 1) });
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        break;
      case 'list_item_open': {
        const list = lists[lists.length - 1];
        pendingNewlines = Math.max(pendingNewlines, 1);
        const marker = list?.ordered ? `${list.next++}. ` : '• ';
        listMarker = LIST_INDENT.repeat(Math.max(0, lists.length - 1)) + marker;
        lineStart = true;
        fresh = true;
        break;
      }
      case 'blockquote_open':
        startBlock();
        quoteDepth += 1;
        fresh = true;
        break;
      case 'blockquote_close':
        quoteDepth -= 1;
        break;
      case 'fence':
      case 'code_block':
        startBlock();
        emit(token.content.replace(/\n$/, ''), ['codeBlock']);
        break;
      case 'html_block':
        startBlock();
        emit(token.content.replace(/\n$/, ''));
        break;
      case 'hr':
        startBlock();
        emit(RULE, ['muted']);
        break;
      case 'table_open':
        startBlock();
        rowIndex = 0;
        break;
      case 'tr_open':
        if (rowIndex++ > 0) newline();
        cellIndex = 0;
        break;
      case 'th_open':
      case 'td_open':
        if (cellIndex++ > 0) emit(CELL_GAP, ['muted']);
        if (token.type === 'th_open') inline.push('strong');
        break;
      case 'th_close':
        inline.pop();
        break;
      case 'inline':
        inlineTokens(token.children ?? []);
        break;
      default:
        break;
    }
  }

  return spans.map((span) => (span.kinds.includes('codeBlock') ? { ...span, kinds: ['codeBlock'] } : span));
}

export function spansToText(spans: Span[]) {
  return spans.map((span) => span.text).join('');
}
