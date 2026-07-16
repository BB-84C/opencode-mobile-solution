import { describe, expect, it, vi } from 'vitest';

const config = require('../metro.config.js');

describe('Metro native compatibility resolver', () => {
  it('routes the Node punycode builtin name to the installed userland package', () => {
    const resolveRequest = vi.fn(() => ({ filePath: '/punycode.js', type: 'sourceFile' }));
    const context = { resolveRequest };

    expect(config.resolver.resolveRequest(context, 'punycode', 'ios')).toEqual({
      filePath: '/punycode.js',
      type: 'sourceFile',
    });
    expect(resolveRequest).toHaveBeenCalledWith(context, 'punycode/', 'ios');
  });

  it('passes unrelated modules through unchanged', () => {
    const resolveRequest = vi.fn(() => ({ filePath: '/react.js', type: 'sourceFile' }));
    const context = { resolveRequest };

    config.resolver.resolveRequest(context, 'react', 'ios');

    expect(resolveRequest).toHaveBeenCalledWith(context, 'react', 'ios');
  });
});
