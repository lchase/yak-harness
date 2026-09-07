import { describe, expect, test } from "vitest";
import { gateMarker, gateRepromptMarker } from "./constants.js";
import {
  contractLines,
  type GateStepInput,
  parseReply,
  readFields,
  resolveGates,
  schemaSha,
  validateAnswer,
} from "./gate-bridge.js";

const SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["proceed", "narrow", "abort"] },
    notes: { type: "string" },
  },
  required: ["decision"],
} as Record<string, unknown>;

const fields = () => {
  const r = readFields(SCHEMA);
  if (!r.ok) throw new Error(r.reason);
  return r.fields;
};

// ── readFields / contractLines ──────────────────────────────────────

describe("readFields", () => {
  test("flat scalar/enum object → fields with required flags", () => {
    const r = readFields(SCHEMA);
    expect(r).toEqual({
      ok: true,
      fields: [
        {
          name: "decision",
          kind: "enum",
          required: true,
          members: ["proceed", "narrow", "abort"],
        },
        { name: "notes", kind: "string", required: false },
      ],
    });
  });

  test("boolean, number, integer", () => {
    const r = readFields({
      type: "object",
      properties: {
        ok: { type: "boolean" },
        count: { type: "number" },
        n: { type: "integer" },
      },
    });
    expect(r.ok && r.fields.map((f) => f.kind)).toEqual([
      "boolean",
      "number",
      "number",
    ]);
  });

  test("nested object property → not ok", () => {
    const r = readFields({
      type: "object",
      properties: { meta: { type: "object", properties: {} } },
    });
    expect(r).toMatchObject({ ok: false });
  });

  test("array property → not ok", () => {
    const r = readFields({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    });
    expect(r).toMatchObject({ ok: false });
  });

  test("no properties map → not ok", () => {
    expect(readFields({ type: "object" })).toMatchObject({ ok: false });
  });
});

describe("contractLines", () => {
  test("one line per field, by type", () => {
    expect(contractLines(fields())).toEqual([
      "decision: proceed | narrow | abort",
      "notes: <optional text>",
    ]);
  });

  test("required string vs boolean vs number", () => {
    const r = readFields({
      type: "object",
      properties: {
        title: { type: "string" },
        urgent: { type: "boolean" },
        weight: { type: "number" },
      },
      required: ["title"],
    });
    expect(r.ok && contractLines(r.fields)).toEqual([
      "title: <text>",
      "urgent: yes | no",
      "weight: <number>",
    ]);
  });
});

describe("schemaSha", () => {
  test("stable and key-order independent", () => {
    const a = schemaSha(SCHEMA);
    const reordered = {
      required: ["decision"],
      properties: {
        notes: { type: "string" },
        decision: { enum: ["proceed", "narrow", "abort"], type: "string" },
      },
      type: "object",
    } as Record<string, unknown>;
    expect(schemaSha(reordered)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{6}$/);
  });

  test("differs when the schema differs", () => {
    expect(schemaSha({ a: 1 })).not.toBe(schemaSha({ a: 2 }));
  });
});

// ── parseReply ─────────────────────────────────────────────────────

describe("parseReply", () => {
  test("clean reply → answer, optional field included", () => {
    expect(
      parseReply("decision: narrow\nnotes: skip the test", fields()),
    ).toEqual({
      status: "answer",
      answer: { decision: "narrow", notes: "skip the test" },
    });
  });

  test("normalisation: casing, spacing, quotes; optional omitted", () => {
    expect(parseReply("  decision : 'Proceed' ", fields())).toEqual({
      status: "answer",
      answer: { decision: "proceed" },
    });
  });

  test("last field absorbs trailing lines", () => {
    const out = parseReply(
      "decision: abort\nnotes: line one\nline two",
      fields(),
    );
    expect(out).toEqual({
      status: "answer",
      answer: { decision: "abort", notes: "line one\nline two" },
    });
  });

  test("pure chatter → chatter (does not count)", () => {
    expect(parseReply("yeah go for it", fields())).toEqual({
      status: "chatter",
    });
  });

  test("a URL whose text merely contains a field name as a substring stays chatter", () => {
    // `notes` is a substring of "annotations"; must not burn the re-prompt.
    expect(
      parseReply(
        "see https://ci.example.com/annotations/42 for the log",
        fields(),
      ),
    ).toEqual({ status: "chatter" });
  });

  test("colon + a field name but no valid line → malformed (botched attempt)", () => {
    expect(parseReply("decision - proceed: yes?", fields())).toMatchObject({
      status: "malformed",
    });
  });

  test("invalid enum → malformed naming the allowed values", () => {
    const out = parseReply("decision: maybe", fields());
    expect(out.status).toBe("malformed");
    expect(out.faults?.[0]).toContain("proceed | narrow | abort");
  });

  test("duplicate field → malformed, never picks one", () => {
    const out = parseReply("decision: proceed\ndecision: abort", fields());
    expect(out).toMatchObject({ status: "malformed" });
    expect(out.faults?.[0]).toContain("more than once");
  });

  test("missing required field → malformed", () => {
    expect(parseReply("notes: hello", fields())).toMatchObject({
      status: "malformed",
      faults: ["`decision` is required"],
    });
  });

  test("boolean + number coercion and faults", () => {
    const r = readFields({
      type: "object",
      properties: { ok: { type: "boolean" }, n: { type: "number" } },
      required: ["ok", "n"],
    });
    if (!r.ok) throw new Error("bad");
    expect(parseReply("ok: YES\nn: 3.5", r.fields)).toEqual({
      status: "answer",
      answer: { ok: true, n: 3.5 },
    });
    expect(parseReply("ok: maybe\nn: lots", r.fields)).toMatchObject({
      status: "malformed",
    });
  });
});

// ── validateAnswer ────────────────────────────────────────────────

describe("validateAnswer", () => {
  test("valid answer passes", () => {
    expect(validateAnswer(SCHEMA, { decision: "proceed" })).toEqual({
      ok: true,
    });
  });

  test("schema-invalid answer the parser missed is caught", () => {
    // `decision` present but wrong type sneaks past a hand-built object
    expect(validateAnswer(SCHEMA, { decision: 3 } as never)).toMatchObject({
      ok: false,
    });
  });
});

// ── resolveGates ──────────────────────────────────────────────────

const gateComment = () =>
  `prompt\n${gateMarker({ run: "r1", step: "s1", schemaSha: "abc123" })}`;

const req = (answerSchema: Record<string, unknown> = SCHEMA) => {
  const w = readFields(answerSchema);
  return {
    answerSchema,
    fields: w.ok ? w.fields : null,
    bridgeError: w.ok ? null : w.reason,
  };
};

/** Stamp `createdAt` on comments given without one, in array order. */
const stamp = (
  comments: { body: string; authorAssociation: string; createdAt?: string }[],
) =>
  comments.map((c, i) => ({
    createdAt: c.createdAt ?? `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    ...c,
  }));

type LooseComment = {
  body: string;
  authorAssociation: string;
  createdAt?: string;
};
const step = (
  o: {
    issue?: number;
    runId?: string;
    stepId?: string;
    request?: GateStepInput["request"];
    comments?: LooseComment[];
  } = {},
): GateStepInput => ({
  issue: o.issue ?? 1,
  runId: o.runId ?? "r1",
  stepId: o.stepId ?? "s1",
  request: o.request === undefined ? req() : o.request,
  comments: stamp(o.comments ?? []),
});

describe("resolveGates", () => {
  test("no gate comment yet → nothing posted, plan A will surface it", () => {
    const r = resolveGates([step()]);
    expect(r).toEqual({
      gatesPosted: [],
      gateReplies: [],
      gateReprompts: [],
      gateFailures: [],
    });
  });

  test("nested answerSchema → gateFailure, never posted", () => {
    const r = resolveGates([
      step({
        request: req({
          type: "object",
          properties: { meta: { type: "object", properties: {} } },
        }),
      }),
    ]);
    expect(r.gateFailures).toHaveLength(1);
    expect(r.gatesPosted).toEqual([]);
  });

  test("unreadable request → gateFailure", () => {
    const r = resolveGates([step({ request: null })]);
    expect(r.gateFailures[0]).toMatchObject({ issue: 1, stepId: "s1" });
  });

  test("gate posted + valid owner reply → gateReply, marked posted", () => {
    const r = resolveGates([
      step({
        comments: [
          { body: gateComment(), authorAssociation: "NONE" },
          { body: "decision: proceed", authorAssociation: "OWNER" },
        ],
      }),
    ]);
    expect(r.gatesPosted).toEqual(["r1\ts1"]);
    expect(r.gateReplies).toEqual([
      { issue: 1, runId: "r1", stepId: "s1", answer: { decision: "proceed" } },
    ]);
  });

  test("CONTRIBUTOR / NONE reply ignored", () => {
    const r = resolveGates([
      step({
        comments: [
          { body: gateComment(), authorAssociation: "NONE" },
          { body: "decision: proceed", authorAssociation: "CONTRIBUTOR" },
        ],
      }),
    ]);
    expect(r.gateReplies).toEqual([]);
    expect(r.gateReprompts).toEqual([]);
  });

  test("first malformed reply → one reprompt (attempt 1)", () => {
    const r = resolveGates([
      step({
        comments: [
          { body: gateComment(), authorAssociation: "NONE" },
          { body: "decision: maybe", authorAssociation: "MEMBER" },
        ],
      }),
    ]);
    expect(r.gateReprompts).toHaveLength(1);
    expect(r.gateReprompts[0]).toMatchObject({ attempt: 1 });
    expect(r.gateFailures).toEqual([]);
  });

  test("second malformed reply (after a reprompt marker) → gateFailure", () => {
    const r = resolveGates([
      step({
        comments: [
          { body: gateComment(), authorAssociation: "NONE" },
          { body: "decision: maybe", authorAssociation: "MEMBER" },
          {
            body: gateRepromptMarker({ run: "r1", step: "s1", attempt: 1 }),
            authorAssociation: "NONE",
          },
          { body: "decision: perhaps", authorAssociation: "MEMBER" },
        ],
      }),
    ]);
    expect(r.gateReprompts).toEqual([]);
    expect(r.gateFailures).toHaveLength(1);
  });

  test("chatter between the gate and a good reply is ignored", () => {
    const r = resolveGates([
      step({
        comments: [
          { body: gateComment(), authorAssociation: "NONE" },
          { body: "thanks, looking now", authorAssociation: "OWNER" },
          { body: "decision: abort", authorAssociation: "OWNER" },
        ],
      }),
    ]);
    expect(r.gateReplies[0]).toMatchObject({ answer: { decision: "abort" } });
  });

  test("after a yak-answered marker, further comments are ignored", () => {
    const r = resolveGates([
      step({
        comments: [
          { body: gateComment(), authorAssociation: "NONE" },
          {
            body: "<!-- yak-answered run=r1 step=s1 -->",
            authorAssociation: "NONE",
          },
          { body: "decision: abort", authorAssociation: "OWNER" },
        ],
      }),
    ]);
    expect(r.gateReplies).toEqual([]);
    expect(r.gatesPosted).toEqual(["r1\ts1"]);
  });

  test("schema-invalid reply the parser passed is treated as malformed", () => {
    // A schema requiring notes non-empty via minLength — parser accepts, ajv rejects.
    const schema = {
      type: "object",
      properties: { decision: { type: "string", minLength: 20 } },
      required: ["decision"],
    } as Record<string, unknown>;
    const r = resolveGates([
      step({
        request: req(schema),
        comments: [
          {
            body: `p\n${gateMarker({ run: "r1", step: "s1", schemaSha: "z" })}`,
            authorAssociation: "NONE",
          },
          { body: "decision: short", authorAssociation: "OWNER" },
        ],
      }),
    ]);
    expect(r.gateReprompts).toHaveLength(1);
  });

  test("resolution orders comments by createdAt, not array position", () => {
    const r = resolveGates([
      step({
        comments: [
          // Reply listed *before* the gate comment but stamped later.
          {
            body: "decision: abort",
            authorAssociation: "OWNER",
            createdAt: "2026-01-02T00:00:00Z",
          },
          {
            body: gateComment(),
            authorAssociation: "NONE",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ]);
    expect(r.gateReplies[0]).toMatchObject({ answer: { decision: "abort" } });
  });

  test("two unbridgeable gate steps on one issue keep both reasons", () => {
    const r = resolveGates([
      step({ stepId: "a", request: null }),
      step({ stepId: "b", request: null }),
    ]);
    expect(r.gateFailures).toHaveLength(2);
    expect(r.gateFailures.map((f) => f.stepId)).toEqual(["a", "b"]);
  });
});
