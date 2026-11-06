import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  attachmentFromBase64,
  base64ByteLength,
  formatAttachmentSize,
  sniffMime,
  toFilePart,
  unsupportedAttachmentReason,
  validateAttachment,
  type PromptAttachment,
} from './prompt-attachments';

function attachment(overrides: Partial<PromptAttachment> = {}): PromptAttachment {
  return { id: 'a1', filename: 'shot.jpg', mime: 'image/jpeg', size: 1024, dataUrl: 'data:image/jpeg;base64,AAAA', ...overrides };
}

describe('base64ByteLength', () => {
  it('counts decoded bytes, not characters, and honours padding', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('AAAA')).toBe(3);
    expect(base64ByteLength('AAA=')).toBe(2);
    expect(base64ByteLength('AA==')).toBe(1);
  });
});

describe('attachmentFromBase64', () => {
  it('builds a data URL and takes its size from the payload itself', () => {
    const built = attachmentFromBase64({ filename: 'a.png', mime: 'image/png', base64: 'AAAA' });
    expect(built.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(built.size).toBe(3);
    expect(built.id).toMatch(/\S/);
  });

  it('gives two picks of the same file different ids, so one can be removed alone', () => {
    const a = attachmentFromBase64({ filename: 'a.png', mime: 'image/png', base64: 'AAAA' });
    const b = attachmentFromBase64({ filename: 'a.png', mime: 'image/png', base64: 'AAAA' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('validateAttachment', () => {
  it('accepts a normal image and a normal PDF', () => {
    expect(validateAttachment({ filename: 'a.jpg', mime: 'image/jpeg', size: 10 }, [])).toBeNull();
    expect(validateAttachment({ filename: 'a.pdf', mime: 'application/pdf', size: 10 }, [])).toBeNull();
  });

  it('refuses a type the model cannot read inline', () => {
    expect(validateAttachment({ filename: 'a.zip', mime: 'application/zip', size: 10 }, [])).toMatch(/a\.zip/);
    expect(validateAttachment({ filename: 'a.heic', mime: 'image/heic', size: 10 }, [])).toMatch(/a\.heic/);
  });

  it('refuses an image or PDF over its limit and says the limit', () => {
    expect(validateAttachment({ filename: 'big.jpg', mime: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 }, [])).toMatch(/5 MB/);
    expect(validateAttachment({ filename: 'big.jpg', mime: 'image/jpeg', size: MAX_IMAGE_BYTES }, [])).toBeNull();
    expect(validateAttachment({ filename: 'big.pdf', mime: 'application/pdf', size: MAX_PDF_BYTES + 1 }, [])).toMatch(/20 MB/);
  });

  it('refuses one attachment past the per-message limit', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => attachment({ id: `a${index}` }));
    expect(validateAttachment({ filename: 'one-more.jpg', mime: 'image/jpeg', size: 10 }, full)).toMatch(String(MAX_ATTACHMENTS));
    expect(validateAttachment({ filename: 'fits.jpg', mime: 'image/jpeg', size: 10 }, full.slice(1))).toBeNull();
  });
});

describe('toFilePart', () => {
  it('produces the file part the prompt endpoint accepts', () => {
    expect(toFilePart(attachment())).toEqual({
      type: 'file',
      mime: 'image/jpeg',
      filename: 'shot.jpg',
      url: 'data:image/jpeg;base64,AAAA',
    });
  });
});

describe('unsupportedAttachmentReason', () => {
  const image = attachment();
  const pdf = attachment({ id: 'p', filename: 'paper.pdf', mime: 'application/pdf' });

  it('allows what the model declares it can read', () => {
    expect(unsupportedAttachmentReason([image, pdf], { attachment: true, input: { image: true, pdf: true } }, 'Opus')).toBeNull();
  });

  it('names the model and the kind it cannot read', () => {
    expect(unsupportedAttachmentReason([pdf], { attachment: true, input: { image: true, pdf: false } }, 'Mini')).toMatch(/Mini.*PDF/);
    expect(unsupportedAttachmentReason([image], { attachment: false }, 'Text-only')).toMatch(/Text-only.*image/);
  });

  it('lets the server decide when the model declares nothing', () => {
    expect(unsupportedAttachmentReason([image, pdf], undefined, 'Unknown')).toBeNull();
  });

  it('has nothing to object to without attachments', () => {
    expect(unsupportedAttachmentReason([], { attachment: false }, 'Text-only')).toBeNull();
  });
});

describe('sniffMime', () => {
  it('reads the type from the payload, whatever the picker claimed', () => {
    expect(sniffMime('iVBORw0KGgoAAAANSUhEUg')).toBe('image/png');
    expect(sniffMime('/9j/4AAQSkZJRgABAQ')).toBe('image/jpeg');
    expect(sniffMime('R0lGODlhAQABAIAAAP')).toBe('image/gif');
    expect(sniffMime('UklGRiQAAABXRUJQVlA4')).toBe('image/webp');
    expect(sniffMime('JVBERi0xLjcKJ')).toBe('application/pdf');
  });

  it('admits it does not know rather than guessing', () => {
    expect(sniffMime('UEsDBBQAAAAIA')).toBeUndefined();
    expect(sniffMime('UklGRiQAAABBVkkg')).toBeUndefined();
    expect(sniffMime('')).toBeUndefined();
  });
});

describe('formatAttachmentSize', () => {
  it('reads like a file browser', () => {
    expect(formatAttachmentSize(900)).toBe('900 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(3 * 1024 * 1024 + 400_000)).toBe('3.4 MB');
  });
});
