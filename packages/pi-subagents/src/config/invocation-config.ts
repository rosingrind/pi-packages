import type { AgentConfig, ThinkingLevel } from "#src/types";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
}

/**
 * Merge agent-config invocation defaults with tool-call params.
 *
 * Precedence is params-first: an explicit tool-call field overrides the
 * agent config's default (the tool description advertises model/thinking/
 * max_turns/run_in_background/inherit_context as caller controls). Fields
 * left unset by params fall through to the config, then to parent-inherited
 * defaults.
 *
 * `modelFromParams` means "an explicit model was requested" — by params or a
 * config pin — so a failed resolution must surface instead of silently
 * falling back to the parent model.
 */
export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
} {
  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null || agentConfig?.model != null,
    thinking: (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined,
    maxTurns: params.max_turns ?? agentConfig?.maxTurns,
    inheritContext: params.inherit_context ?? agentConfig?.inheritContext ?? false,
    runInBackground: params.run_in_background ?? agentConfig?.runInBackground ?? false,
  };
}
