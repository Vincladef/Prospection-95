import type { Campaign, Experiment } from "../types";

export const variantGroupKeys = ["search", "iterations", "subject", "initial", "followup0", "followup1", "followup2", "followup3", "followup4", "reply"] as const;
export type VariantGroupKey = typeof variantGroupKeys[number];
export type VariantOverrides = Record<string, unknown>;
export type VariantGroups = Record<VariantGroupKey, Record<string, unknown>>;
type CampaignConfiguration = Pick<Campaign, "targetDescription" | "writingIterations" | "sequence" | "replyIterations">;

export function sameVariantConfiguration(left: unknown, right: unknown): boolean {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export function campaignVariantDefaults(campaign: CampaignConfiguration): VariantGroups {
  const followup = (index: number) => ({ body: campaign.sequence.steps[index + 1], instructions: campaign.sequence.stepInstructions[index + 1] });
  return {
    search: { criteria: campaign.targetDescription },
    iterations: { draftPasses: campaign.writingIterations },
    subject: { subject: campaign.sequence.subject, subjectInstructions: campaign.sequence.subjectInstructions },
    initial: { body: campaign.sequence.steps[0], bodyInstructions: campaign.sequence.stepInstructions[0] },
    followup0: followup(0), followup1: followup(1), followup2: followup(2), followup3: followup(3), followup4: followup(4),
    reply: { replyIterations: campaign.replyIterations },
  };
}

export function resolveVariantGroups(base: VariantGroups, overrides: VariantOverrides): VariantGroups {
  return Object.fromEntries(variantGroupKeys.map(key => {
    const raw = overrides[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [key, { ...base[key] }];
    const value = raw as Record<string, unknown>;
    const fields = key === "search" ? ["criteria"] : key === "iterations" ? ["draftPasses"]
      : key === "subject" ? ["subject", "subjectInstructions"] : key === "initial" ? ["body", "bodyInstructions"]
      : key === "reply" ? ["replyIterations"] : ["body", "instructions"];
    const merged = { ...Object.fromEntries(fields.map(name => [name, base[key][name]])), ...value };
    for (const name of fields) {
      const original = base[key][name], candidate = value[name];
      if ((typeof original === "string" && typeof candidate !== "string") ||
        (Array.isArray(original) && (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 100 || !candidate.every(item => typeof item === "string")))) merged[name] = original;
    }
    if (key === "reply" && !Array.isArray(value.replyIterations) && typeof value.replyInstructions === "string") {
      merged.replyIterations = (base.reply.replyIterations as string[]).map((text, index) => index === 0 ? [value.replyInstructions, text].filter(Boolean).join("\n\n") : text);
    }
    return [key, merged];
  })) as VariantGroups;
}

/** Store complete effective blocks so existing SQL consumers use exactly what the editor displays. */
export function materializeVariant(base: VariantGroups, overrides: VariantOverrides): VariantOverrides {
  return { ...overrides, ...resolveVariantGroups(base, overrides) };
}

export function experimentReference(experiment: Experiment) {
  return experiment.variants.find(variant => variant.label === "A") ?? experiment.variants[0];
}

/** Existing differences are preserved; an identical block is presented as inherited from this test's A. */
export function editorVariantSnapshot(campaign: CampaignConfiguration, experiments: Experiment[], stored: Record<string, VariantOverrides>): Record<string, VariantOverrides> {
  const defaults = campaignVariantDefaults(campaign);
  const result: Record<string, VariantOverrides> = {};
  for (const experiment of experiments) {
    const reference = experimentReference(experiment);
    if (!reference) continue;
    const referenceGroups = resolveVariantGroups(defaults, stored[reference.id] ?? {});
    for (const variant of experiment.variants) {
      const raw = stored[variant.id] ?? {};
      if (variant.id === reference.id) { result[variant.id] = structuredClone(raw); continue; }
      const effective = resolveVariantGroups(defaults, raw);
      const differences: VariantOverrides = { ...raw };
      for (const key of variantGroupKeys) {
        if (sameVariantConfiguration(referenceGroups[key], effective[key])) delete differences[key];
        else differences[key] = effective[key];
      }
      result[variant.id] = differences;
    }
  }
  return result;
}
