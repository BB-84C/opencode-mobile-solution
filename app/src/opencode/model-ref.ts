import type { ModelRef } from './types';

export type ModelLike =
  | string
  | ModelRef
  | {
      providerID?: unknown;
      modelID?: unknown;
      provider?: unknown;
      id?: unknown;
      name?: unknown;
    }
  | null
  | undefined;

export function parseModelRef(model: ModelLike): ModelRef | undefined {
  if (!model) return undefined;
  if (typeof model === 'string') return parseModelString(model);
  const modelRecord = model as Record<string, unknown>;
  const providerID = stringField(modelRecord.providerID) ?? stringField(modelRecord.provider);
  const modelID = stringField(modelRecord.modelID) ?? stringField(modelRecord.id) ?? stringField(modelRecord.name);
  if (!modelID) return undefined;
  return providerID ? { providerID, modelID } : undefined;
}

export function formatModelDisplay(model: ModelLike): null | { label: string; detail?: string } {
  if (!model) return null;
  if (typeof model === 'string') {
    const parsed = parseModelString(model);
    return parsed ? { label: parsed.modelID, detail: parsed.providerID } : { label: model };
  }
  const modelRecord = model as Record<string, unknown>;
  const modelID = stringField(modelRecord.modelID) ?? stringField(modelRecord.id) ?? stringField(modelRecord.name);
  if (!modelID) return null;
  const providerID = stringField(modelRecord.providerID) ?? stringField(modelRecord.provider);
  return providerID ? { label: modelID, detail: providerID } : { label: modelID };
}

function parseModelString(model: string) {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
