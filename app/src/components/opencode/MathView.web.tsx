import katex from 'katex';
import 'katex/dist/katex.min.css';
import { createElement, useMemo } from 'react';

import { installMathCopy } from './math-copy';

// Copying a selection that contains rendered math puts the TeX source on the
// clipboard instead of the glyphs.
installMathCopy();

/**
 * A formula rendered by KaTeX, the same engine the HTML reports use.
 *
 * Errors do not throw: a formula KaTeX cannot parse is shown as its source in
 * red, so one bad expression never blanks a whole message.
 */
export function MathView({ tex, display = false, color }: { tex: string; display?: boolean; color?: string }) {
  const html = useMemo(
    () => katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' }),
    [tex, display],
  );
  return createElement(display ? 'div' : 'span', {
    className: display ? 'cockpit-math cockpit-math-display' : 'cockpit-math',
    'data-tex': tex,
    'data-display': display ? 'true' : 'false',
    // KaTeX takes its colour from the surrounding element, and a block-level
    // formula sits in a View that sets none, which left it black on black.
    style: display ? { ...displayStyle, color } : { color },
    dangerouslySetInnerHTML: { __html: html },
  });
}

// A long equation scrolls sideways instead of widening the transcript.
const displayStyle = { overflowX: 'auto', overflowY: 'hidden', margin: '6px 0', padding: '2px 0' } as const;
