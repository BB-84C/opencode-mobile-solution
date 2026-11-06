/**
 * Copy rendered math as its TeX source.
 *
 * KaTeX's own copy-tex extension builds the clipboard text from textContent,
 * which drops every paragraph break in a React Native Web page (blocks are
 * divs). This keeps the browser's own selection text, line breaks included,
 * and only swaps each formula for its source for the instant of the copy:
 * inline math becomes `$...$`, display math `$$...$$`.
 */
const MATH_SELECTOR = '.cockpit-math';

export function installMathCopy() {
  if (typeof document === 'undefined') return;
  const flag = '__cockpitMathCopy';
  const holder = window as unknown as Record<string, boolean>;
  if (holder[flag]) return;
  holder[flag] = true;
  document.addEventListener('copy', onCopy);
}

function onCopy(event: ClipboardEvent) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return;
  const original = selection.getRangeAt(0);
  const range = original.cloneRange();

  // A selection that starts or ends inside a formula takes the whole formula.
  const startMath = closestMath(range.startContainer);
  if (startMath) range.setStartBefore(startMath);
  const endMath = closestMath(range.endContainer);
  if (endMath) range.setEndAfter(endMath);

  const formulas = Array.from(document.querySelectorAll<HTMLElement>(MATH_SELECTOR)).filter((element) =>
    range.intersectsNode(element),
  );
  if (formulas.length === 0) return;

  const saved = formulas.map((element) => {
    const children = Array.from(element.childNodes);
    const tex = element.dataset.tex ?? '';
    const source = element.dataset.display === 'true' ? `$$${tex}$$` : `$${tex}$`;
    element.replaceChildren(document.createTextNode(source));
    return { element, children };
  });
  let text = '';
  try {
    selection.removeAllRanges();
    selection.addRange(range);
    text = selection.toString();
  } finally {
    for (const { element, children } of saved) element.replaceChildren(...children);
    selection.removeAllRanges();
    selection.addRange(original);
  }
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
}

function closestMath(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(MATH_SELECTOR) ?? null;
}
