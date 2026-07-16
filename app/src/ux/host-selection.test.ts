import { describe, expect, it } from 'vitest';

import { routeForSelectedHost } from './host-selection';

describe('host selection UX', () => {
  it('routes an explicitly selected relay into its existing sessions list', () => {
    expect(routeForSelectedHost('host-live')).toBe('/two');
  });

  it('does not route when there is no selected host id', () => {
    expect(routeForSelectedHost('')).toBeNull();
    expect(routeForSelectedHost('   ')).toBeNull();
  });
});
