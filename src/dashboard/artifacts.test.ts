import { describe, expect, it } from "vitest";
import { parseAssessment, parsePlanSteps } from "./artifacts.js";

describe("parseAssessment", () => {
  it("keeps only well-typed fields and trims the summary", () => {
    const a = parseAssessment(
      JSON.stringify({
        kind: "bug",
        confidence: 0.95,
        needsDesign: false,
        needsDocs: true,
        likelySubtasks: 1,
        summary: "  Fix the backoff cap in retry.ts  ",
        extra: "ignored",
      }),
    );
    expect(a).toEqual({
      kind: "bug",
      confidence: 0.95,
      needsDesign: false,
      needsDocs: true,
      likelySubtasks: 1,
      summary: "Fix the backoff cap in retry.ts",
    });
  });

  it("returns null for missing / malformed / empty artifacts", () => {
    expect(parseAssessment(null)).toBeNull();
    expect(parseAssessment("not json")).toBeNull();
    expect(parseAssessment("[]")).toBeNull();
    expect(parseAssessment("{}")).toBeNull();
    expect(parseAssessment(JSON.stringify({ kind: 123 }))).toBeNull();
  });
});

describe("parsePlanSteps", () => {
  it("extracts the non-empty string checklist", () => {
    expect(
      parsePlanSteps(JSON.stringify({ steps: ["edit a", "", "edit b", 3] })),
    ).toEqual(["edit a", "edit b"]);
  });

  it("returns null when there is no usable checklist", () => {
    expect(parsePlanSteps(null)).toBeNull();
    expect(parsePlanSteps(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parsePlanSteps(JSON.stringify({ steps: "nope" }))).toBeNull();
  });
});
