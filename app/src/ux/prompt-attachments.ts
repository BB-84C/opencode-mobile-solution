import type { FilePart } from '@/src/opencode/types';

/**
 * Files attached to a prompt travel inside the prompt itself, as a `file` part
 * whose `url` is a data URL. The server hands that straight to the model, so
 * only what models read natively is accepted here: images and PDFs. Anything
 * else would reach the model as bytes it cannot interpret.
 *
 * The limits keep one message to a size the relay, the tailnet and a phone's
 * memory all handle comfortably. The image limit matches what the Anthropic API
 * accepts per image; the PDF limit leaves room for a paper with figures.
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MIME = 'application/pdf';

export interface PromptAttachment {
  id: string;
  filename: string;
  mime: string;
  /** Decoded size in bytes. */
  size: number;
  dataUrl: string;
}

type AttachmentKind = 'image' | 'pdf';

function kindOf(mime: string): AttachmentKind | null {
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (mime === PDF_MIME) return 'pdf';
  return null;
}

// Leading bytes of each accepted format, as they appear once base64-encoded.
// The photo picker re-encodes some images and not others, so its label can be
// wrong; the bytes cannot be.
const BASE64_SIGNATURES: ReadonlyArray<readonly [prefix: string, mime: string]> = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['JVBERi0', 'application/pdf'],
];

export function sniffMime(base64: string): string | undefined {
  const signature = BASE64_SIGNATURES.find(([prefix]) => base64.startsWith(prefix));
  if (signature) return signature[1];
  // RIFF container with WEBP at byte 8.
  if (base64.startsWith('UklGR') && base64.slice(10, 16) === 'BXRUJQ') return 'image/webp';
  return undefined;
}

export function base64ByteLength(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

let attachmentSequence = 0;

export function attachmentFromBase64(input: { filename: string; mime: string; base64: string }): PromptAttachment {
  attachmentSequence += 1;
  return {
    id: `att-${Date.now().toString(36)}-${attachmentSequence}`,
    filename: input.filename,
    mime: input.mime,
    size: base64ByteLength(input.base64),
    dataUrl: `data:${input.mime};base64,${input.base64}`,
  };
}

/** Returns a sentence to show the user, or null when the file can be attached. */
export function validateAttachment(
  candidate: { filename: string; mime: string; size: number },
  existing: readonly PromptAttachment[],
): string | null {
  if (existing.length >= MAX_ATTACHMENTS) {
    return `A message can carry at most ${MAX_ATTACHMENTS} attachments.`;
  }
  const kind = kindOf(candidate.mime);
  if (!kind) {
    return `${candidate.filename} is not an image (PNG, JPEG, GIF, WebP) or a PDF, so the model could not read it.`;
  }
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
  if (candidate.size > limit) {
    return `${candidate.filename} is ${formatAttachmentSize(candidate.size)}; ${kind === 'image' ? 'images' : 'PDFs'} are limited to ${formatAttachmentSize(limit)}.`;
  }
  return null;
}

export function toFilePart(attachment: PromptAttachment): FilePart {
  return { type: 'file', mime: attachment.mime, filename: attachment.filename, url: attachment.dataUrl };
}

interface ModelCapabilities {
  attachment?: boolean;
  input?: unknown;
  [key: string]: unknown;
}

/**
 * Refuses before sending when the selected model says it cannot read what is
 * attached. A model that declares nothing is left to the server, which knows
 * more than this client does.
 */
export function unsupportedAttachmentReason(
  attachments: readonly PromptAttachment[],
  capabilities: ModelCapabilities | undefined,
  modelName: string,
): string | null {
  if (attachments.length === 0 || !capabilities) return null;
  const input = capabilities.input && typeof capabilities.input === 'object'
    ? capabilities.input as Record<string, unknown>
    : undefined;
  for (const kind of new Set(attachments.map((attachment) => kindOf(attachment.mime)))) {
    if (!kind) continue;
    const declared = input?.[kind];
    const readable = typeof declared === 'boolean' ? declared : capabilities.attachment !== false;
    if (!readable) {
      return `${modelName} cannot read ${kind === 'pdf' ? 'PDF' : 'image'} attachments. Pick another model or remove the attachment.`;
    }
  }
  return null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / 1024 / 1024;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}
