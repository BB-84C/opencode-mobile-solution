import type { DiffLine, FileDiff } from '@/src/opencode/types';

export type DiffCopyActionId = 'copy' | 'copy-raw' | 'open-text-view';
export type DiffPresentationMode = 'unified' | 'split';

export interface DiffViewport {
  width: number;
  height: number;
  isTablet?: boolean;
}

export function diffToUnifiedText(diffs: FileDiff[]) {
  return diffs
    .map((diff) => {
      const lines = [`diff -- ${diff.path}`, `--- ${diff.path}`, `+++ ${diff.path}`];
      for (const hunk of diff.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        lines.push(...hunk.lines.map(formatDiffLine));
      }
      return lines.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

export function createDiffCopyModel(
  diffs: FileDiff[],
  viewport: DiffViewport = { width: 390, height: 844, isTablet: false },
  requestedMode?: DiffPresentationMode,
) {
  const text = diffToUnifiedText(diffs);
  const disabled = text.length === 0;
  return {
    changedFiles: diffs.length,
    title: 'Diffs',
    text,
    presentation: createDiffPresentationModel(viewport, requestedMode),
    actions: [
      { id: 'copy', label: 'Copy', disabled },
      { id: 'copy-raw', label: 'Copy raw', disabled },
      { id: 'open-text-view', label: 'Open text view', disabled },
    ] satisfies Array<{ id: DiffCopyActionId; label: string; disabled: boolean }>,
  };
}

export function createDiffPresentationModel(viewport: DiffViewport, requestedMode?: DiffPresentationMode) {
  const landscape = viewport.width > viewport.height;
  const splitAllowed = Boolean(viewport.isTablet) || landscape;
  const mode = requestedMode === 'split' && splitAllowed ? 'split' : 'unified';
  return {
    defaultMode: 'unified' as const,
    mode: mode as DiffPresentationMode,
    splitAllowed,
    wordWrap: mode === 'unified',
    unifiedTextDefault: true,
  };
}

function formatDiffLine(line: DiffLine) {
  if (line.type === 'add') return `+${line.content}`;
  if (line.type === 'remove') return `-${line.content}`;
  return ` ${line.content}`;
}
