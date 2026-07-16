import { parseModelRef, type ModelLike } from './model-ref';
import type {
  Agent,
  ConfiguredProvider,
  ConfiguredProvidersResponse,
  MessageWithParts,
  ModelRef,
  ProviderModel,
} from './types';

/** One selectable model, scoped to the configured-provider response of one machine. */
export interface ConfiguredModelEntry {
  key: string;
  ref: ModelRef;
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  releaseDate?: string | number;
  status?: string;
  model: ProviderModel;
}

export interface PromptSessionSelection {
  agent?: string;
  model?: ModelLike;
  variant?: string | null;
}

/**
 * Persisted prompt choices. Per-agent/per-model maps prevent an agent or model
 * switch from accidentally reusing an unrelated choice.
 */
export interface StoredPromptSelection {
  agentName?: string;
  model?: ModelLike;
  variant?: string | null;
  modelByAgent?: Readonly<Record<string, ModelLike>>;
  variantByModel?: Readonly<Record<string, string | null | undefined>>;
}

/** Explicit UI choice. `null` (or `undefined`) means the server default variant. */
export interface PromptSelectionOverride {
  agentName?: string;
  model?: ModelLike;
  variant?: string | null;
}

export interface PromptExecutionContract {
  agents: readonly Agent[];
  /** The wire response from `GET /config/providers?directory=...`. */
  configuredProviders?: ConfiguredProvidersResponse;
  /** The equivalent normalized fields used by MachineExecutionContract. */
  providers?: readonly ConfiguredProvider[];
  providerDefaults?: Readonly<Record<string, string>>;
  configModel?: ModelLike;
}

export interface ResolvePromptSelectionInput {
  contract: PromptExecutionContract;
  messages?: readonly MessageWithParts[];
  session?: PromptSessionSelection;
  stored?: StoredPromptSelection;
  override?: PromptSelectionOverride;
}

export interface ResolvedPromptSelection {
  agentName: string;
  model: ModelRef;
  variant?: string;
}

interface ModelCandidate {
  model: ModelLike;
  variant: VariantCandidate;
}

interface VariantCandidate {
  present: boolean;
  value?: string | null;
}

interface LastUserSelection {
  agentName?: string;
  model?: ModelCandidate;
}

/**
 * Flattens one machine's configured providers into a deterministic picker list.
 * Deprecated models are intentionally absent from both the picker and validation.
 */
export function flattenConfiguredModels(response: ConfiguredProvidersResponse): ConfiguredModelEntry[] {
  const flattened: Array<ConfiguredModelEntry & { originalOrder: number }> = [];
  let originalOrder = 0;

  for (const provider of response.providers ?? []) {
    for (const [modelMapKey, rawModel] of Object.entries(provider.models ?? {})) {
      const model = rawModel as ProviderModel;
      const status = stringValue(model.status);
      if (status?.toLowerCase() === 'deprecated') continue;

      const providerID = stringValue(model.providerID) ?? stringValue(provider.id);
      const modelID = stringValue(model.id) ?? stringValue(modelMapKey);
      if (!providerID || !modelID) continue;

      flattened.push({
        key: modelRefKey({ providerID, modelID }),
        ref: { providerID, modelID },
        providerID,
        providerName: stringValue(provider.name) ?? providerID,
        modelID,
        modelName: stringValue(model.name) ?? modelID,
        releaseDate: model.release_date,
        status,
        model,
        originalOrder: originalOrder++,
      });
    }
  }

  flattened.sort((left, right) => {
    const leftRelease = releaseValue(left.releaseDate);
    const rightRelease = releaseValue(right.releaseDate);
    if (leftRelease !== rightRelease) return rightRelease > leftRelease ? 1 : -1;

    return (
      compareText(left.modelName, right.modelName) ||
      compareText(left.providerName, right.providerName) ||
      compareText(left.providerID, right.providerID) ||
      compareText(left.modelID, right.modelID) ||
      left.originalOrder - right.originalOrder
    );
  });

  return flattened.map(({ originalOrder: _originalOrder, ...entry }) => entry);
}

/**
 * Returns the server's variant keys without imposing a client-side enum.
 * The first `undefined` item is the explicit "Default" picker option.
 */
export function variantsForModel(
  catalogOrResponse: readonly ConfiguredModelEntry[] | ConfiguredProvidersResponse,
  model: ModelLike,
): Array<string | undefined> {
  const ref = parseModelRef(model);
  if (!ref) return [];

  const catalog = Array.isArray(catalogOrResponse)
    ? catalogOrResponse
    : flattenConfiguredModels(catalogOrResponse as ConfiguredProvidersResponse);
  const entry = catalog.find((candidate) => sameModel(candidate.ref, ref));
  if (!entry) return [];

  return [undefined, ...Object.keys(entry.model.variants ?? {})];
}

/**
 * Restores the prompt execution tuple using the OpenCode TUI precedence:
 * explicit UI choice, last user message, session metadata, persisted choice,
 * agent default, config default, then the current machine's provider default.
 */
export function resolvePromptSelection(input: ResolvePromptSelectionInput): ResolvedPromptSelection | undefined {
  const response = providersResponse(input.contract);
  const catalog = flattenConfiguredModels(response);
  const selectableAgents = input.contract.agents.filter(isSelectableAgent);
  if (selectableAgents.length === 0 || catalog.length === 0) return undefined;

  const lastUser = selectionFromLastUserMessage(input.messages ?? []);
  const agentName = firstValidAgent(
    selectableAgents,
    input.override?.agentName,
    lastUser.agentName,
    input.session?.agent,
    input.stored?.agentName,
  );
  if (!agentName) return undefined;

  const agent = selectableAgents.find((candidate) => candidate.name === agentName);
  if (!agent) return undefined;

  const candidates: ModelCandidate[] = [];
  appendContextCandidate(candidates, input.override, agentName);
  appendContextCandidate(candidates, lastUserSelectionAsContext(lastUser), agentName);
  appendContextCandidate(candidates, input.session, agentName);
  appendStoredCandidate(candidates, input.stored, agentName);
  appendModelCandidate(candidates, agent.model, variantFromObject(agent));
  appendModelCandidate(candidates, input.contract.configModel, absentVariant());

  let selectedCandidate: ModelCandidate | undefined;
  let selectedEntry: ConfiguredModelEntry | undefined;
  for (const candidate of candidates) {
    const ref = parseModelRef(candidate.model);
    if (!ref) continue;
    const match = catalog.find((entry) => sameModel(entry.ref, ref));
    if (!match) continue;
    selectedCandidate = candidate;
    selectedEntry = match;
    break;
  }

  if (!selectedCandidate || !selectedEntry) {
    selectedEntry = providerFallback(response, catalog);
    if (!selectedEntry) return undefined;
    selectedCandidate = { model: selectedEntry.ref, variant: absentVariant() };
  }

  const variant = resolveVariant({
    selectedCandidate,
    selectedEntry,
    stored: input.stored,
    agent,
  });

  return {
    agentName,
    model: selectedEntry.ref,
    ...(variant === undefined ? {} : { variant }),
  };
}

export function modelRefKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}

export function isSelectableAgent(agent: Agent): boolean {
  return !agent.hidden && agent.mode !== 'subagent';
}

function providersResponse(contract: PromptExecutionContract): ConfiguredProvidersResponse {
  if (contract.configuredProviders) return contract.configuredProviders;
  return {
    providers: [...(contract.providers ?? [])],
    default: { ...(contract.providerDefaults ?? {}) },
  };
}

function firstValidAgent(agents: readonly Agent[], ...names: Array<string | undefined>): string | undefined {
  for (const name of names) {
    if (name && agents.some((agent) => agent.name === name)) return name;
  }
  return agents[0]?.name;
}

function selectionFromLastUserMessage(messages: readonly MessageWithParts[]): LastUserSelection {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role !== 'user') continue;

    const modelRecord = recordValue(info.model);
    const outerVariant = variantFromObject(info);
    const nestedVariant = variantFromObject(modelRecord);
    return {
      agentName: stringValue(info.agent),
      ...(info.model
        ? {
            model: {
              model: info.model as ModelLike,
              variant: nestedVariant.present ? nestedVariant : outerVariant,
            },
          }
        : {}),
    };
  }
  return {};
}

function lastUserSelectionAsContext(selection: LastUserSelection): PromptSessionSelection {
  if (!selection.model) return { agent: selection.agentName };
  return {
    agent: selection.agentName,
    model: selection.model.model,
    ...(selection.model.variant.present ? { variant: selection.model.variant.value } : {}),
  };
}

function appendContextCandidate(
  candidates: ModelCandidate[],
  context: PromptSelectionOverride | PromptSessionSelection | undefined,
  selectedAgentName: string,
): void {
  if (!context?.model) return;
  const contextRecord = context as unknown as Record<string, unknown>;
  const contextAgent = stringValue(contextRecord.agentName) ?? stringValue(contextRecord.agent);
  if (contextAgent && contextAgent !== selectedAgentName) return;

  const modelRecord = recordValue(context.model);
  const nestedVariant = variantFromObject(modelRecord);
  const outerVariant = variantFromObject(context);
  appendModelCandidate(candidates, context.model, nestedVariant.present ? nestedVariant : outerVariant);
}

function appendStoredCandidate(
  candidates: ModelCandidate[],
  stored: StoredPromptSelection | undefined,
  selectedAgentName: string,
): void {
  if (!stored) return;
  const perAgentModel = stored.modelByAgent?.[selectedAgentName];
  if (perAgentModel) {
    appendModelCandidate(candidates, perAgentModel, absentVariant());
    return;
  }
  if (stored.model && (!stored.agentName || stored.agentName === selectedAgentName)) {
    appendModelCandidate(candidates, stored.model, variantFromObject(stored));
  }
}

function appendModelCandidate(candidates: ModelCandidate[], model: ModelLike, variant: VariantCandidate): void {
  if (model) candidates.push({ model, variant });
}

function resolveVariant(input: {
  selectedCandidate: ModelCandidate;
  selectedEntry: ConfiguredModelEntry;
  stored?: StoredPromptSelection;
  agent: Agent;
}): string | undefined {
  const validKeys = new Set(Object.keys(input.selectedEntry.model.variants ?? {}));

  // A variant attached to the winning model source is authoritative. Invalid
  // values are cleared here instead of falling through to a stale old model.
  if (input.selectedCandidate.variant.present) {
    return validatedVariant(input.selectedCandidate.variant.value, validKeys);
  }

  const storedVariant = variantForStoredModel(input.stored, input.selectedEntry.ref);
  if (storedVariant.present) return validatedVariant(storedVariant.value, validKeys);

  const agentModel = parseModelRef(input.agent.model as ModelLike);
  if (agentModel && sameModel(agentModel, input.selectedEntry.ref)) {
    const agentVariant = variantFromObject(input.agent);
    if (agentVariant.present) return validatedVariant(agentVariant.value, validKeys);
  }

  return undefined;
}

function variantForStoredModel(stored: StoredPromptSelection | undefined, model: ModelRef): VariantCandidate {
  if (!stored) return absentVariant();
  const key = modelRefKey(model);
  if (stored.variantByModel && Object.prototype.hasOwnProperty.call(stored.variantByModel, key)) {
    return { present: true, value: stored.variantByModel[key] };
  }

  const storedModel = parseModelRef(stored.model);
  if (storedModel && sameModel(storedModel, model)) return variantFromObject(stored);
  return absentVariant();
}

function validatedVariant(value: string | null | undefined, validKeys: ReadonlySet<string>): string | undefined {
  if (value === undefined || value === null || value === '' || value === 'default') return undefined;
  return validKeys.has(value) ? value : undefined;
}

function providerFallback(
  response: ConfiguredProvidersResponse,
  catalog: readonly ConfiguredModelEntry[],
): ConfiguredModelEntry | undefined {
  for (const provider of response.providers ?? []) {
    const providerID = stringValue(provider.id);
    if (!providerID) continue;

    const defaultModelID = response.default?.[providerID];
    if (defaultModelID) {
      const defaultEntry = catalog.find(
        (entry) => entry.providerID === providerID && entry.modelID === defaultModelID,
      );
      if (defaultEntry) return defaultEntry;
    }

    for (const [mapKey, model] of Object.entries(provider.models ?? {})) {
      const modelID = stringValue(model.id) ?? stringValue(mapKey);
      const entry = catalog.find((candidate) => candidate.providerID === providerID && candidate.modelID === modelID);
      if (entry) return entry;
    }
  }
  return catalog[0];
}

function variantFromObject(value: unknown): VariantCandidate {
  const record = recordValue(value);
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'variant')) return absentVariant();
  const variant = record.variant;
  return {
    present: true,
    value: typeof variant === 'string' || variant === null ? variant : undefined,
  };
}

function absentVariant(): VariantCandidate {
  return { present: false };
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function releaseValue(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareText(left: string, right: string): number {
  const foldedLeft = left.toLocaleLowerCase('en-US');
  const foldedRight = right.toLocaleLowerCase('en-US');
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
