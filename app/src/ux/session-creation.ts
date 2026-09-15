/**
 * The new-session form: what it can offer, and what it produces.
 *
 * Four choices go in — machine, working directory, agent, model — but they do
 * not all travel the same way. Creating a session takes the machine and the
 * directory; the agent and the model are applied to the session afterwards,
 * because that is how the backend models them. So this returns two things, and
 * a caller that forgets the second silently drops the user's agent and model.
 *
 * Agents and models come from the chosen machine's execution contract. A machine
 * whose contract has not been fetched yet can still be chosen, but it cannot
 * offer either list, and saying so beats rendering two empty dropdowns.
 */

import { flattenConfiguredModels, isSelectableAgent } from '../opencode/execution-contract';
import type { Agent, MachineExecutionContract, ModelRef } from '../opencode/types';

export interface CreationMachine {
  connectionId: string;
  targetId: string;
  targetName: string;
}

export interface CreationAgentOption {
  name: string;
  description?: string;
}

export interface CreationModelOption {
  key: string;
  ref: ModelRef;
  label: string;
}

export interface SessionCreationOptions {
  agents: CreationAgentOption[];
  models: CreationModelOption[];
  defaultDirectory?: string;
  defaultAgentName?: string;
  defaultModelKey?: string;
  /** True when the machine's contract has not been fetched, so neither list can
   *  be offered yet. */
  contractMissing: boolean;
}

export interface SessionCreationChoices {
  machine: CreationMachine | null;
  directory?: string;
  agentName?: string;
  modelKey?: string;
  title?: string;
}

export interface SessionCreationPlan {
  /** Arguments for the create call. */
  create: { connectionId: string; relayTargetID: string; directory?: string; title?: string };
  /** Applied to the session once it exists, since creation cannot carry them. */
  apply: { agentName?: string; model?: ModelRef };
}

export function buildSessionCreationOptions(contract?: MachineExecutionContract): SessionCreationOptions {
  if (!contract) {
    return { agents: [], models: [], contractMissing: true };
  }

  const agents = (contract.agents ?? [])
    .filter((agent: Agent) => isSelectableAgent(agent))
    .map((agent: Agent) => ({ name: agent.name, description: agent.description }));

  const models = flattenConfiguredModels({
    providers: contract.providers ?? [],
    default: contract.providerDefaults ?? {},
  }).map((entry) => ({
    key: entry.key,
    ref: entry.ref,
    label: `${entry.providerName} · ${entry.modelName}`,
  }));

  return {
    agents,
    models,
    defaultDirectory: contract.directory,
    defaultAgentName: agents[0]?.name,
    // The configured default is a model id without its provider, so match on the
    // id rather than assuming the two strings are comparable.
    defaultModelKey: contract.configModel
      ? models.find((model) => model.ref.modelID === contract.configModel)?.key ?? models[0]?.key
      : models[0]?.key,
    contractMissing: false,
  };
}

export type SessionCreationValidation =
  | { ok: true; plan: SessionCreationPlan }
  | { ok: false; reason: string };

export function validateSessionCreation(
  choices: SessionCreationChoices,
  options: SessionCreationOptions,
): SessionCreationValidation {
  if (!choices.machine) return { ok: false, reason: 'Choose a machine first' };

  const directory = choices.directory?.trim() || options.defaultDirectory;
  const agentName = choices.agentName ?? options.defaultAgentName;
  const modelKey = choices.modelKey ?? options.defaultModelKey;

  if (choices.agentName && !options.agents.some((agent) => agent.name === choices.agentName)) {
    return { ok: false, reason: `This machine does not offer the agent "${choices.agentName}"` };
  }
  const model = modelKey ? options.models.find((entry) => entry.key === modelKey) : undefined;
  if (choices.modelKey && !model) {
    return { ok: false, reason: 'This machine does not offer the selected model' };
  }

  return {
    ok: true,
    plan: {
      create: {
        connectionId: choices.machine.connectionId,
        relayTargetID: choices.machine.targetId,
        ...(directory ? { directory } : {}),
        ...(choices.title?.trim() ? { title: choices.title.trim() } : {}),
      },
      apply: {
        ...(agentName ? { agentName } : {}),
        ...(model ? { model: model.ref } : {}),
      },
    },
  };
}
