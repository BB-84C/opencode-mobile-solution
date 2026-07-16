import type { ConfiguredModelEntry } from '@/src/opencode/execution-contract';

export function filterConfiguredModels(models: readonly ConfiguredModelEntry[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...models];
  return models.filter((entry) =>
    [entry.modelName, entry.modelID, entry.providerName, entry.providerID, entry.key]
      .some((value) => value.toLocaleLowerCase().includes(needle)),
  );
}
