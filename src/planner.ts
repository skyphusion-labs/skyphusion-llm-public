// Storyboard planner dispatcher (v0.28.0).
//
// Takes a brief + character bible + model selection, dispatches to one of
// callAnthropic (BYOK), callXai (BYOK), or aiRun (Workers AI binding) for
// a single non-streaming completion, strips ```json fences, JSON.parses
// the result, runs validateStoryboard, and returns the validated
// StoryboardValidated or the error list. Does NOT submit anything to
// RunPod; the caller takes the result and either re-prompts the model
// with the errors or hands the validated value to serializeStoryboardYaml
// for the bundle.
//
// BYOK secrets (ANTHROPIC_API_KEY, XAI_API_KEY) are consumed inside the
// provider modules; this file never reads them directly. Workers AI runs
// through aiRun (which uses env.AI + env.GATEWAY_ID).

import type { Env } from "./env";
import { callAnthropic } from "./providers/anthropic";
import { callXai } from "./providers/xai";
import { aiRun, aiLogId } from "./ai-binding";
import { extractOutput, detectProviderFailure } from "./output-extract";
import {
  validateStoryboard,
  type StoryboardValidated,
} from "./storyboard-validate";
import {
  type PlanningProvider,
  findPlanningModel,
  plannerProviderFor,
} from "./planner-catalog";
import {
  type PlannerCharacter,
  buildPlanningSystemPrompt,
  buildPlanningUserMessage,
  buildRefinementSystemPrompt,
  buildRefinementUserMessage,
  stripJsonFences,
} from "./planner-prompt";

export type { PlannerCharacter, PlanningProvider };

export interface PlanStoryboardArgs {
  brief: string;
  characters: PlannerCharacter[];
  // PlanningModel.id from planner-catalog, e.g. "anthropic/claude-opus-4-7"
  // or "@cf/zai-org/glm-4.7-flash".
  model: string;
}

export type PlanStoryboardResult =
  | {
      ok: true;
      storyboard: StoryboardValidated;
      raw: string;
      provider: PlanningProvider;
      model: string;
      logId: string | null;
    }
  | {
      ok: false;
      errors: string[];
      raw: string | null;
      provider: PlanningProvider | null;
      model: string;
      logId: string | null;
    };

export async function planStoryboard(
  env: Env,
  args: PlanStoryboardArgs,
): Promise<PlanStoryboardResult> {
  const modelEntry = findPlanningModel(args.model);
  if (!modelEntry) {
    return {
      ok: false,
      errors: [`model "${args.model}" is not in the planning catalog`],
      raw: null,
      provider: null,
      model: args.model,
      logId: null,
    };
  }

  const provider = plannerProviderFor(modelEntry);
  const systemPrompt = buildPlanningSystemPrompt();
  const userMessage = buildPlanningUserMessage(args.brief, args.characters);

  let result: unknown;
  let logId: string | null = null;

  try {
    if (provider === "anthropic") {
      // Anthropic Messages API takes system as a top-level field, so we
      // hand systemPrompt to callAnthropic separately and put only the
      // user content in messages.
      const messages = [{ role: "user", content: userMessage }];
      const r = await callAnthropic(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "xai") {
      // xAI is OpenAI-compatible; system rides as the first message.
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      const r = await callXai(env, modelEntry, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      // Workers AI binding (env.AI.run via aiRun). Same system-as-first-
      // message convention as xAI; Workers AI's chat input accepts the
      // OpenAI-style role+content shape across the @cf/... text models.
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      result = await aiRun(env, modelEntry.id, { messages });
      logId = aiLogId(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`provider call failed: ${message}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return {
      ok: false,
      errors: [`model execution failed: ${providerFailure}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const completion = extractOutput(result);
  const json = stripJsonFences(completion);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [
        `model output was not valid JSON: ${message}`,
        `raw output starts with: ${json.slice(0, 200)}`,
      ],
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  const validation = validateStoryboard(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  return {
    ok: true,
    storyboard: validation.value,
    raw: completion,
    provider,
    model: args.model,
    logId,
  };
}

// ---------- Refinement dispatcher (v0.50.0) ----------
//
// Mirrors planStoryboard's plumbing (provider dispatch, JSON parse, validation)
// but builds a different prompt: the system message tells the model to apply
// ONE delta and preserve everything else, and the user message ships the
// current storyboard JSON + the new instruction.

export interface RefineStoryboardArgs {
  storyboard: unknown;
  message: string;
  model: string;
}

export async function refineStoryboard(
  env: Env,
  args: RefineStoryboardArgs,
): Promise<PlanStoryboardResult> {
  const modelEntry = findPlanningModel(args.model);
  if (!modelEntry) {
    return {
      ok: false,
      errors: [`model "${args.model}" is not in the planning catalog`],
      raw: null,
      provider: null,
      model: args.model,
      logId: null,
    };
  }

  const provider = plannerProviderFor(modelEntry);
  const systemPrompt = buildRefinementSystemPrompt();
  const userMessage = buildRefinementUserMessage(args.storyboard, args.message);

  let result: unknown;
  let logId: string | null = null;

  try {
    if (provider === "anthropic") {
      const messages = [{ role: "user", content: userMessage }];
      const r = await callAnthropic(env, modelEntry, systemPrompt, messages);
      result = r.raw;
      logId = r.logId;
    } else if (provider === "xai") {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      const r = await callXai(env, modelEntry, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
      result = await aiRun(env, modelEntry.id, { messages });
      logId = aiLogId(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`provider call failed: ${message}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return {
      ok: false,
      errors: [`model execution failed: ${providerFailure}`],
      raw: null,
      provider,
      model: args.model,
      logId,
    };
  }

  const completion = extractOutput(result);
  const jsonStr = stripJsonFences(completion);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [
        `model output was not valid JSON: ${message}`,
        `raw output starts with: ${jsonStr.slice(0, 200)}`,
      ],
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  const validation = validateStoryboard(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: completion,
      provider,
      model: args.model,
      logId,
    };
  }

  return {
    ok: true,
    storyboard: validation.value,
    raw: completion,
    provider,
    model: args.model,
    logId,
  };
}
