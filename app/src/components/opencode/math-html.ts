import katex from 'katex';
import MarkdownIt from 'markdown-it';

import { mathPlugin } from './markdown-math';

/**
 * Messages with math, as HTML for the phone's WebView.
 *
 * iOS has no text view that can typeset TeX, so a message that contains math
 * is rendered with KaTeX, the engine the desktop and the HTML reports use, and
 * shown in a WebView. Each formula keeps its source in `data-tex`, so copying a
 * selection puts `$...$` on the clipboard rather than the glyphs.
 */
const parser = new MarkdownIt({ typographer: true, html: false });
mathPlugin(parser);

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formula(tex: string, display: boolean) {
  const rendered = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
  const attributes = `data-display="${display}" data-tex="${escapeAttribute(tex)}"`;
  return display
    ? `<div class="cockpit-math cockpit-math-display" ${attributes}>${rendered}</div>`
    : `<span class="cockpit-math" ${attributes}>${rendered}</span>`;
}

parser.renderer.rules.math_inline = (tokens, index) => formula(tokens[index].content, false);
parser.renderer.rules.math_display = (tokens, index) => formula(tokens[index].content, true);
parser.renderer.rules.math_block = (tokens, index) => `${formula(tokens[index].content, true)}\n`;

export function containsMath(markdown: string) {
  if (!markdown.includes('$') && !markdown.includes('\\(') && !markdown.includes('\\[')) return false;
  return parser
    .parse(markdown, {})
    .some((token) => token.type === 'math_block' || (token.children ?? []).some((child) => child.type.startsWith('math_')));
}

export function markdownToHtml(markdown: string) {
  return parser.render(markdown);
}

export type MathColors = {
  text: string;
  muted: string;
  primary: string;
  warning: string;
  codeBackground: string;
  border: string;
};

/**
 * Same behaviour as math-copy.ts on the desktop, as a string because it runs
 * inside the WebView: each formula in the selection is swapped for its source
 * while the browser computes the selection text, then put back.
 */
const COPY_SCRIPT = `
document.addEventListener('copy', function (event) {
  var selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) return;
  var original = selection.getRangeAt(0);
  var range = original.cloneRange();
  function closestMath(node) {
    var element = node.nodeType === 1 ? node : node.parentElement;
    return element ? element.closest('.cockpit-math') : null;
  }
  var startMath = closestMath(range.startContainer);
  if (startMath) range.setStartBefore(startMath);
  var endMath = closestMath(range.endContainer);
  if (endMath) range.setEndAfter(endMath);
  var formulas = Array.prototype.filter.call(document.querySelectorAll('.cockpit-math'), function (element) {
    return range.intersectsNode(element);
  });
  if (!formulas.length) return;
  var saved = formulas.map(function (element) {
    var children = Array.prototype.slice.call(element.childNodes);
    var tex = element.getAttribute('data-tex') || '';
    var source = element.getAttribute('data-display') === 'true' ? '$$' + tex + '$$' : '$' + tex + '$';
    element.replaceChildren(document.createTextNode(source));
    return { element: element, children: children };
  });
  var text = '';
  try {
    selection.removeAllRanges();
    selection.addRange(range);
    text = selection.toString();
  } finally {
    saved.forEach(function (item) { item.element.replaceChildren.apply(item.element, item.children); });
    selection.removeAllRanges();
    selection.addRange(original);
  }
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
});
`;

/** Reports the content height so an inline WebView can size itself to it. */
const HEIGHT_SCRIPT = `
(function () {
  var content = document.getElementById('content');
  var last = 0;
  function report() {
    var height = Math.ceil(content.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    window.ReactNativeWebView.postMessage(JSON.stringify({ height: height }));
  }
  new ResizeObserver(report).observe(content);
  if (document.fonts) document.fonts.ready.then(report);
  report();
})();
`;

const FOCUS_SCRIPT = `
(function () {
  var focus = document.getElementById('focus');
  if (focus) focus.scrollIntoView({ block: 'start' });
})();
`;

export function mathDocument({
  bodyHtml,
  katexCss,
  colors,
  scrollable,
}: {
  bodyHtml: string;
  katexCss: string;
  colors: MathColors;
  /** A whole page that scrolls itself (the Select text sheet), rather than one message sized by its host. */
  scrollable: boolean;
}) {
  const style = `
html, body { margin: 0; padding: 0; background: transparent; }
body { color: ${colors.text}; font: 14px/20px -apple-system, system-ui, sans-serif; -webkit-text-size-adjust: 100%; overflow-wrap: anywhere; -webkit-user-select: text; user-select: text; }
#content { padding: ${scrollable ? '12px' : '0'}; }
#content > :first-child { margin-top: 0; }
#content > :last-child { margin-bottom: 0; }
p { margin: 0 0 6px; }
h1 { font-size: 20px; line-height: 25px; margin: 10px 0 5px; }
h2 { font-size: 18px; line-height: 23px; margin: 8px 0 4px; }
h3, h4, h5, h6 { font-size: 16px; line-height: 21px; margin: 7px 0 3px; }
a { color: ${colors.primary}; }
code { font-family: Menlo, monospace; font-size: 13px; color: ${colors.warning}; }
pre { background: ${colors.codeBackground}; border: 1px solid ${colors.border}; padding: 10px; margin: 0 0 6px; overflow-x: auto; }
pre code { color: ${colors.text}; font-size: 12px; line-height: 18px; }
blockquote { margin: 0 0 6px; padding-left: 10px; border-left: 2px solid ${colors.border}; color: ${colors.muted}; }
ul, ol { margin: 0 0 8px; padding-left: 22px; }
table { border-collapse: collapse; margin: 0 0 6px; }
th, td { border: 1px solid ${colors.border}; padding: 6px; }
hr { border: 0; border-top: 1px solid ${colors.border}; }
.speaker { color: ${colors.muted}; font-weight: 600; margin: 14px 0 4px; }
.cockpit-math-display { overflow-x: auto; overflow-y: hidden; margin: 6px 0; padding: 2px 0; }
.katex { font-size: 1.1em; }
`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><style>${katexCss}</style><style>${style}</style></head><body><div id="content">${bodyHtml}</div><script>${COPY_SCRIPT}${scrollable ? FOCUS_SCRIPT : HEIGHT_SCRIPT}</script></body></html>`;
}
