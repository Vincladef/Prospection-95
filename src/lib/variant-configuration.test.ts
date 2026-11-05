import { describe, expect, it } from "vitest";
import type { Campaign, Experiment } from "../types";
import { campaignVariantDefaults, editorVariantSnapshot, materializeVariant, resolveVariantGroups, sameVariantConfiguration } from "./variant-configuration";

const campaign = {
  targetDescription: "Public initial", writingIterations: ["Rédiger", "Relire"], replyIterations: ["Répondre", "Polir"],
  sequence: { subject: "Objet", subjectInstructions: "Consignes objet", steps: ["J0", "R1", "R2", "R3", "R4", "R5"], stepInstructions: ["I0", "I1", "I2", "I3", "I4", "I5"] },
} as Campaign;
const experiment = { id: "test-1", variants: [{ id: "a1", label: "A" }, { id: "b1", label: "B" }] } as Experiment;
const defaults = campaignVariantDefaults(campaign);
const reference = { initial: { bodyInstructions: "Instructions A1", metadata: "Conserver" }, search: { criteria: "Public A1" }, iterations: { draftPasses: ["Itération A1"] } };

describe("reference and variant configurations", () => {
  it.each([
    {},
    { initial: { bodyInstructions: "Anciennes consignes B" } },
    { subject: { subject: "Objet B" }, followup0: { instructions: "" }, iterations: { draftPasses: ["B1", "B2"] } },
    { reply: { replyInstructions: "Ancienne consigne de réponse" }, extension: { provenance: "Conserver" } },
  ])("projects an existing B into the editor without changing any effective stored setting (%j)", rawB => {
    const editor = editorVariantSnapshot(campaign, [experiment], { a1: reference, b1: rawB });
    const projected = materializeVariant(resolveVariantGroups(defaults, editor.a1), editor.b1);
    expect(projected).toEqual(materializeVariant(defaults, rawB));
  });

  it("follows a new A in inherited blocks while preserving the customized B subject and unknown data", () => {
    const originalA = resolveVariantGroups(defaults, reference);
    const rawB = materializeVariant(originalA, { subject: { subject: "Objet propre B" }, extension: { provenance: "Conserver" } });
    const editor = editorVariantSnapshot(campaign, [experiment], { a1: reference, b1: rawB });
    expect(editor.b1.initial).toBeUndefined();
    const nextA = resolveVariantGroups(defaults, { ...reference, initial: { bodyInstructions: "Nouvelles consignes A1" } });
    const persistedB = materializeVariant(nextA, editor.b1);
    expect(persistedB.initial).toMatchObject({ bodyInstructions: "Nouvelles consignes A1" });
    expect(persistedB.subject).toMatchObject({ subject: "Objet propre B" });
    expect(persistedB.extension).toEqual({ provenance: "Conserver" });
  });

  it("keeps explicit empty strings and applies legacy reply instructions exactly once", () => {
    const effective = resolveVariantGroups(defaults, { initial: { body: "", bodyInstructions: "" }, reply: { replyInstructions: "Contexte" } });
    expect(effective.initial).toEqual({ body: "", bodyInstructions: "" });
    expect(effective.reply.replyIterations).toEqual(["Contexte\n\nRépondre", "Polir"]);
    expect(resolveVariantGroups(defaults, materializeVariant(effective, {})).reply.replyIterations).toEqual(["Contexte\n\nRépondre", "Polir"]);
  });

  it("uses each test's A rather than another test or the position of variants in an array", () => {
    const second = { id: "test-2", variants: [{ id: "b2", label: "B" }, { id: "a2", label: "A" }] } as Experiment;
    const a2 = { initial: { bodyInstructions: "Instructions A2" } };
    const snapshot = editorVariantSnapshot(campaign, [experiment, second], { a1: reference, b1: materializeVariant(resolveVariantGroups(defaults, reference), {}), a2, b2: materializeVariant(resolveVariantGroups(defaults, a2), {}) });
    expect(snapshot.b1.initial).toBeUndefined(); expect(snapshot.b2.initial).toBeUndefined();
    expect(snapshot.a2.initial).toEqual({ bodyInstructions: "Instructions A2" });
  });

  it("accepts partial blocks, rejects invalid field types and compares configuration independent of JSON key order", () => {
    const effective = resolveVariantGroups(defaults, { initial: { body: null, bodyInstructions: "Instructions" }, iterations: { draftPasses: [] } });
    expect(effective.initial).toEqual({ body: "J0", bodyInstructions: "Instructions" });
    expect(effective.iterations.draftPasses).toEqual(["Rédiger", "Relire"]);
    expect(sameVariantConfiguration({ initial: { body: "J0", bodyInstructions: "I0" } }, { initial: { bodyInstructions: "I0", body: "J0" } })).toBe(true);
  });
});
