import { describe, expect, it } from 'vitest';

import { markdownStyleSource } from './markdown-theme';

describe('MarkdownText TUI layout styles', () => {
  it('keeps inline code in the surrounding text line instead of rendering a padded chip', () => {
    expect(markdownStyleSource.code_inline).toMatchObject({
      borderWidth: 0,
      padding: 0,
      backgroundColor: 'transparent',
      lineHeight: 20,
    });
  });

  it('uses compact transcript typography so useful content is not pushed off-screen', () => {
    expect(markdownStyleSource.body).toMatchObject({ fontSize: 14, lineHeight: 20 });
    expect(markdownStyleSource.heading1).toMatchObject({ fontSize: 20, lineHeight: 25 });
  });
});
