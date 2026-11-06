import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import {
  MAX_ATTACHMENTS,
  attachmentFromBase64,
  sniffMime,
  validateAttachment,
  type PromptAttachment,
} from './prompt-attachments';

export type AttachmentSource = 'photos' | 'files';

export interface PickedAttachments {
  attachments: PromptAttachment[];
  /** One sentence per file that was picked but could not be attached. */
  rejected: string[];
}

interface Candidate {
  filename: string;
  mime: string;
  size: number;
  read(): Promise<string>;
}

function readWebBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The browser could not read the file.'));
    reader.readAsDataURL(blob);
  });
}

async function photoCandidates(remaining: number): Promise<Candidate[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: remaining,
    // Below 1 the picker re-encodes, which turns an iPhone's HEIC into JPEG.
    quality: 0.8,
    base64: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    filename: asset.fileName ?? `photo-${index + 1}.jpg`,
    mime: asset.mimeType ?? 'image/jpeg',
    size: asset.fileSize ?? 0,
    read: async () => {
      if (asset.base64) return asset.base64;
      if (asset.file) return readWebBlob(asset.file);
      return new File(asset.uri).base64();
    },
  }));
}

async function fileCandidates(): Promise<Candidate[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/*', 'application/pdf'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    filename: asset.name,
    mime: asset.mimeType ?? 'application/octet-stream',
    size: asset.size ?? 0,
    read: () => (Platform.OS === 'web' && asset.file ? readWebBlob(asset.file) : new File(asset.uri).base64()),
  }));
}

export async function pickAttachments(
  source: AttachmentSource,
  existing: readonly PromptAttachment[],
): Promise<PickedAttachments> {
  const remaining = MAX_ATTACHMENTS - existing.length;
  if (remaining <= 0) return { attachments: [], rejected: [`A message can carry at most ${MAX_ATTACHMENTS} attachments.`] };

  const candidates = source === 'photos' ? await photoCandidates(remaining) : await fileCandidates();
  const attachments: PromptAttachment[] = [];
  const rejected: string[] = [];
  for (const candidate of candidates) {
    // Check what the picker reported before reading anything into memory, then
    // again against the bytes, because the reported type and size can be wrong.
    const early = validateAttachment(candidate, [...existing, ...attachments]);
    if (early && !(candidate.mime === 'application/octet-stream' || candidate.mime.startsWith('image/'))) {
      rejected.push(early);
      continue;
    }
    const base64 = await candidate.read();
    const attachment = attachmentFromBase64({
      filename: candidate.filename,
      mime: sniffMime(base64) ?? candidate.mime,
      base64,
    });
    const problem = validateAttachment(attachment, [...existing, ...attachments]);
    if (problem) rejected.push(problem);
    else attachments.push(attachment);
  }
  return { attachments, rejected };
}
