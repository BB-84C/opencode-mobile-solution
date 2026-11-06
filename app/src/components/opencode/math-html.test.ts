import { describe, expect, it } from 'vitest';

import { containsMath, markdownToHtml, mathDocument } from './math-html';

describe('containsMath', () => {
  it('finds inline, display and block math, and ignores prices and code', () => {
    expect(containsMath('Energy $E=mc^2$')).toBe(true);
    expect(containsMath('so \\(x\\) holds')).toBe(true);
    expect(containsMath('$$\nx\n$$')).toBe(true);
    expect(containsMath('It costs $5 and $10')).toBe(false);
    expect(containsMath('`$x$` and\n```\n$$y$$\n```')).toBe(false);
  });
});

describe('markdownToHtml', () => {
  it('renders formulas with KaTeX and keeps their source for copying', () => {
    const html = markdownToHtml('Energy $E_0 < 1$ and\n\n$$\n\\frac{a}{b}\n$$');
    expect(html).toContain('<span class="cockpit-math" data-display="false" data-tex="E_0 &lt; 1">');
    expect(html).toContain('<div class="cockpit-math cockpit-math-display" data-display="true" data-tex="\\frac{a}{b}">');
    expect(html).toContain('class="katex"');
    expect(html).toContain('<p>Energy ');
  });

  it('escapes raw HTML in the message instead of rendering it', () => {
    expect(markdownToHtml('<img src=x onerror=alert(1)> $x$')).toContain('&lt;img');
  });

  it('shows a formula KaTeX cannot parse instead of failing the message', () => {
    expect(markdownToHtml('broken $\\frac{1}{$ here')).toContain('katex-error');
  });
});

describe('mathDocument', () => {
  it('wraps the body with the stylesheet, colours and the copy script', () => {
    const doc = mathDocument({
      bodyHtml: '<p>hi</p>',
      katexCss: '.katex{}',
      colors: { text: '#eee', muted: '#888', primary: '#0af', warning: '#fa0', codeBackground: '#111', border: '#333' },
      scrollable: false,
    });
    expect(doc).toContain('.katex{}');
    expect(doc).toContain('color: #eee');
    expect(doc).toContain('<div id="content"><p>hi</p></div>');
    expect(doc).toContain("addEventListener('copy'");
    expect(doc).toContain('ReactNativeWebView.postMessage');
  });
});
