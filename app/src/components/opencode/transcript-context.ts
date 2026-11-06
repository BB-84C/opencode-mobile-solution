import { createContext } from 'react';

import type { MessageWithParts } from '@/src/opencode/types';

/**
 * Reads the loaded transcript at the moment it is needed. A getter rather than
 * the array, so streaming updates do not re-render every message card.
 */
export const TranscriptContext = createContext<(() => MessageWithParts[]) | null>(null);
