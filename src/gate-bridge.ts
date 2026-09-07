// The gate bridge's pure core (spec §7, prototype
// `docs/design/prototype-gate-bridge.md`).
//
// yak's engine stays ignorant that GitHub exists (CLAUDE.md invariant 1):
// this module never touches yak or GitHub. It turns a
// `GatePendingRequest`'s `answerSchema` into a reply contract, parses a
// human's line-based `key: value` reply back into a candidate answer with
// **no LLM**, and validates it with `ajv` before anything is written.
//
// The three shapes flowing out of here — `GateReply`, `GateReprompt`,
// `GateFailure` — are consumed by `plan` as data (it composes the comment
// bodies) and executed by `apply`.

import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import {
  ACCEPTED_AUTHOR_ASSOCIATIONS,
  GATE_ANSWERED_MARKER_RE,
  GATE_MARKER_RE,
  GATE_REPROMPT_LIMIT,
  GATE_REPROMPT_MARKER_RE,
  gateAnsweredMarker,
  gateMarker,
  gateRepromptMarker,
} from "./constants.js";

// ── answerSchema → fields ────────────────────────────────────────────

export type FieldKind = "enum" | "string" | "boolean" | "number";

export interface GateField {
  name: string;
  kind: FieldKind;
  required: boolean;
  /** Enum members, verbatim — the canonical casing an answer is normalised to. */
  members?: string[];
}

export type FieldsResult =
  | { ok: true; fields: GateField[] }
  | { ok: false; reason: string };

/**
 * Walk a flat `answerSchema` into {@link GateField}s (spec §7.1). Any
 * nested object / array property, a non-string enum, an unknown scalar
 * type, or a missing `properties` map fails with a human-readable reason
 * — `plan` routes that gate to `yak:failed` (spec §7.1).
 */
export function readFields(
  answerSchema: Record<string, unknown>,
): FieldsResult {
  const props = answerSchema.properties;
  if (!props || typeof props !== "object") {
    return { ok: false, reason: "answerSchema has no `properties` object" };
  }
  const required = Array.isArray(answerSchema.required)
    ? (answerSchema.required as unknown[]).filter(
        (r): r is string => typeof r === "string",
      )
    : [];

  const fields: GateField[] = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const req = required.includes(name);

    if (Array.isArray(p.enum)) {
      if (!p.enum.every((e) => typeof e === "string")) {
        return { ok: false, reason: `\`${name}\` is a non-string enum` };
      }
      fields.push({ name, kind: "enum", required: req, members: p.enum });
      continue;
    }

    const t = p.type;
    if (t === "object" || t === "array" || "properties" in p || "items" in p) {
      return {
        ok: false,
        reason: `\`${name}\` is a nested object/array — a harness-bridged answerSchema must be a flat object of scalar / enum properties (spec §7.1)`,
      };
    }
    if (t === "string") fields.push({ name, kind: "string", required: req });
    else if (t === "boolean")
      fields.push({ name, kind: "boolean", required: req });
    else if (t === "number" || t === "integer")
      fields.push({ name, kind: "number", required: req });
    else {
      return {
        ok: false,
        reason: `\`${name}\` has unsupported type ${JSON.stringify(t ?? null)}`,
      };
    }
  }
  if (fields.length === 0) {
    return { ok: false, reason: "answerSchema has no properties" };
  }
  return { ok: true, fields };
}

/** One contract line per field (spec §7.1 type table). */
export function contractLines(fields: GateField[]): string[] {
  return fields.map((f): string => {
    switch (f.kind) {
      case "enum":
        return `${f.name}: ${(f.members ?? []).join(" | ")}`;
      case "string":
        return `${f.name}: ${f.required ? "<text>" : "<optional text>"}`;
      case "boolean":
        return `${f.name}: yes | no`;
      case "number":
        return `${f.name}: <number>`;
      default:
        return `${f.name}: <value>`;
    }
  });
}

/** Short, order-independent digest of an `answerSchema` (the `schema-sha` marker field). */
export function schemaSha(answerSchema: Record<string, unknown>): string {
  return createHash("sha1")
    .update(canonical(answerSchema))
    .digest("hex")
    .slice(0, 6);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ── Comment bodies ──────────────────────────────────────────────────

const FENCE = "```";

/** The gate prompt comment (spec §7.1). `rendered` is passed through verbatim. */
export function gateCommentBody(a: {
  runId: string;
  stepId: string;
  rendered: string;
  fields: GateField[];
  schemaSha: string;
}): string {
  return [
    `🐂 **yak needs a decision — \`${a.stepId}\`**`,
    "",
    a.rendered,
    "",
    "---",
    "**To answer, reply to this comment with:**",
    FENCE,
    ...contractLines(a.fields),
    FENCE,
    `Run \`${a.runId}\` · step \`${a.stepId}\``,
    "",
    gateMarker({ run: a.runId, step: a.stepId, schemaSha: a.schemaSha }),
  ].join("\n");
}

/** The single re-prompt on a malformed reply (spec §7.3). */
export function repromptCommentBody(a: {
  runId: string;
  stepId: string;
  attempt: number;
  faults: string[];
  fields: GateField[];
}): string {
  return [
    `⚠️ Couldn't read that answer for \`${a.stepId}\`:`,
    ...a.faults.map((f) => `- ${f}`),
    "",
    "Reply again with:",
    FENCE,
    ...contractLines(a.fields),
    FENCE,
    "(I'll try once more, then flag this for a human.)",
    "",
    gateRepromptMarker({ run: a.runId, step: a.stepId, attempt: a.attempt }),
  ].join("\n");
}

/** The comment carrying the `yak-answered` marker, posted after `yak resume` (spec §7.5). */
export function answeredCommentBody(a: {
  runId: string;
  stepId: string;
}): string {
  return [
    `🐂 answer recorded for \`${a.stepId}\` — resuming run \`${a.runId}\`.`,
    gateAnsweredMarker({ run: a.runId, step: a.stepId }),
  ].join("\n");
}

// ── Reply parsing (no LLM) ──────────────────────────────────────────

const LINE_RE = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripQuotes(s: string): string {
  const t = s.trim();
  const first = t[0];
  const lastCh = t.at(-1);
  if (
    t.length >= 2 &&
    ((first === '"' && lastCh === '"') || (first === "'" && lastCh === "'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export interface ParseOutcome {
  /**
   * `answer`    — ≥1 recognised `field:` line, every value well-formed.
   * `malformed` — a recognised or botched attempt with a fault (spec §7.3).
   * `chatter`   — no `field:` line and nothing that looks like an attempt;
   *              ignored, does not count against the re-prompt budget.
   */
  status: "answer" | "malformed" | "chatter";
  answer?: Record<string, unknown>;
  faults?: string[];
}

/**
 * Parse one comment body against the gate's fields (spec §7.2). Line-based
 * `key: value`: trim, flexible `:` spacing, strip surrounding quotes,
 * case-insensitive enum match. The last recognised field absorbs trailing
 * non-`key: value` lines (a multi-line `notes:`). A field given twice is
 * malformed — never pick one.
 */
export function parseReply(body: string, fields: GateField[]): ParseOutcome {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const seen = new Map<string, string[]>();
  let last: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m && byName.has(m[1]!)) {
      const key = m[1]!;
      seen.set(key, [...(seen.get(key) ?? []), m[2]!]);
      last = key;
    } else if (m) {
      last = null; // a `key: value` line for something that is not our field
    } else if (last && line.trim()) {
      const arr = seen.get(last)!;
      arr[arr.length - 1] += `\n${line}`;
    }
  }

  if (seen.size === 0) {
    // A botched attempt (spec §7.2): a `:` somewhere and a schema field
    // name mentioned *as a whole word* (so a URL or prose that merely
    // contains a short field name as a substring stays chatter and does
    // not burn the one re-prompt). Counts against the budget.
    const looksLikeAttempt =
      body.includes(":") &&
      fields.some((f) =>
        new RegExp(
          `(?:^|[^A-Za-z0-9_])${escapeRe(f.name)}(?:[^A-Za-z0-9_]|$)`,
        ).test(body),
      );
    return looksLikeAttempt
      ? {
          status: "malformed",
          faults: [
            "no `field: value` line I recognised — check the field names",
          ],
        }
      : { status: "chatter" };
  }

  const faults: string[] = [];
  const answer: Record<string, unknown> = {};

  for (const f of fields) {
    const vals = seen.get(f.name);
    if (!vals) {
      if (f.required) faults.push(`\`${f.name}\` is required`);
      continue;
    }
    if (vals.length > 1) {
      faults.push(`you gave \`${f.name}\` more than once`);
      continue;
    }
    const v = stripQuotes(vals[0]!);
    switch (f.kind) {
      case "enum": {
        const hit = (f.members ?? []).find(
          (e) => e.toLowerCase() === v.toLowerCase(),
        );
        if (hit === undefined) {
          faults.push(
            `\`${f.name}\` must be one of: ${(f.members ?? []).join(" | ")}`,
          );
        } else answer[f.name] = hit;
        break;
      }
      case "string": {
        if (v === "") {
          if (f.required) faults.push(`\`${f.name}\` is required`);
        } else answer[f.name] = v;
        break;
      }
      case "boolean": {
        const lo = v.toLowerCase();
        if (["yes", "y", "true"].includes(lo)) answer[f.name] = true;
        else if (["no", "n", "false"].includes(lo)) answer[f.name] = false;
        else faults.push(`\`${f.name}\` must be yes or no`);
        break;
      }
      case "number": {
        const n = Number(v);
        if (v === "" || !Number.isFinite(n)) {
          faults.push(`\`${f.name}\` must be a number`);
        } else answer[f.name] = n;
        break;
      }
    }
  }

  if (faults.length > 0) return { status: "malformed", faults };
  return { status: "answer", answer };
}

// ── ajv validation (spec §7.4) ──────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });

export type ValidateResult = { ok: true } | { ok: false; faults: string[] };

/** Validate a parsed answer against `answerSchema` with `ajv` before `writeAnswer`. */
export function validateAnswer(
  answerSchema: Record<string, unknown>,
  answer: Record<string, unknown>,
): ValidateResult {
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(answerSchema);
  } catch (err) {
    return {
      ok: false,
      faults: [`answerSchema did not compile: ${(err as Error).message}`],
    };
  }
  if (validate(answer)) return { ok: true };
  const faults = (validate.errors ?? []).map((e) =>
    `${e.instancePath || "answer"} ${e.message ?? "is invalid"}`.trim(),
  );
  return {
    ok: false,
    faults: faults.length > 0 ? faults : ["answer failed schema validation"],
  };
}

// ── Reply resolution ────────────────────────────────────────────────

/** A valid, schema-checked reply ready to write + resume (spec §7.5). */
export interface GateReply {
  issue: number;
  runId: string;
  stepId: string;
  answer: Record<string, unknown>;
}

/** A first malformed reply needing the one re-prompt (spec §7.3). */
export interface GateReprompt {
  issue: number;
  runId: string;
  stepId: string;
  /** The attempt this re-prompt begins — always `1` (`GATE_REPROMPT_LIMIT`). */
  attempt: number;
  faults: string[];
  /** The walked contract fields — `plan` repeats them in the re-prompt body. */
  fields: GateField[];
}

/** A gate the harness cannot bridge — routes the issue to `yak:failed` (spec §7.1, §7.3). */
export interface GateFailure {
  issue: number;
  runId: string;
  stepId: string;
  broke: string;
}

export interface GateComment {
  body: string;
  authorAssociation: string;
  /** ISO timestamp — resolution sorts by this, not by array position. */
  createdAt: string;
}

/** One suspended run's open gate step plus its request, for resolution. */
export interface GateStepInput {
  issue: number;
  runId: string;
  stepId: string;
  /**
   * `null` when `pending/<stepId>.request.json` could not be read /
   * validated. `fields` is `null` (and `bridgeError` set) when the schema
   * is not flat/bridgeable — both computed once by `observe`.
   */
  request: {
    answerSchema: Record<string, unknown>;
    fields: GateField[] | null;
    bridgeError: string | null;
  } | null;
  comments: GateComment[];
}

export interface GateResolution {
  /** `${runId}\t${stepId}` for gates whose prompt comment is already up. */
  gatesPosted: string[];
  gateReplies: GateReply[];
  gateReprompts: GateReprompt[];
  gateFailures: GateFailure[];
}

const gateKey = (runId: string, stepId: string): string =>
  `${runId}\t${stepId}`;

const anyHarnessMarker = (body: string): boolean =>
  GATE_MARKER_RE.test(body) ||
  GATE_REPROMPT_MARKER_RE.test(body) ||
  GATE_ANSWERED_MARKER_RE.test(body);

/**
 * Resolve every suspended run's open gate steps against the issue's
 * comments (spec §7.2–§7.5). Pure: the caller (`observe`) supplies the
 * request file and comments; `plan` turns the result into actions.
 */
export function resolveGates(steps: GateStepInput[]): GateResolution {
  const out: GateResolution = {
    gatesPosted: [],
    gateReplies: [],
    gateReprompts: [],
    gateFailures: [],
  };

  for (const step of steps) {
    const key = gateKey(step.runId, step.stepId);
    // GitHub's comments payload is chronological in practice; sort by
    // `createdAt` anyway so "after the gate comment" (spec §7.2) never
    // depends on array position. Stable for equal timestamps.
    const comments = [...step.comments]
      .map((c, i) => [c, i] as const)
      .sort(([a, ai], [b, bi]) => {
        const d = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        return Number.isNaN(d) || d === 0 ? ai - bi : d;
      })
      .map(([c]) => c);

    // Schema problems short-circuit — the gate is never posted (spec §7.1).
    if (step.request === null) {
      out.gateFailures.push({
        issue: step.issue,
        runId: step.runId,
        stepId: step.stepId,
        broke: `the gate request file \`pending/${step.stepId}.request.json\` could not be read or is not valid yak gate JSON`,
      });
      continue;
    }
    if (step.request.fields === null) {
      out.gateFailures.push({
        issue: step.issue,
        runId: step.runId,
        stepId: step.stepId,
        broke:
          step.request.bridgeError ??
          "answerSchema is not a flat object of scalar / enum properties (spec §7.1)",
      });
      continue;
    }
    const fields = step.request.fields;

    // Locate the harness's own markers in comment order.
    let gateIdx = -1;
    let repromptIdx = -1;
    let repromptAttempt = 0;
    let answered = false;
    comments.forEach((c, i) => {
      const g = GATE_MARKER_RE.exec(c.body);
      if (g && g[1] === step.runId && g[2] === step.stepId) gateIdx = i;
      const r = GATE_REPROMPT_MARKER_RE.exec(c.body);
      if (r && r[1] === step.runId && r[2] === step.stepId) {
        repromptIdx = i;
        repromptAttempt = Math.max(repromptAttempt, Number(r[3]));
      }
      const a = GATE_ANSWERED_MARKER_RE.exec(c.body);
      if (a && a[1] === step.runId && a[2] === step.stepId) answered = true;
    });

    if (gateIdx === -1) continue; // plan A posts it
    out.gatesPosted.push(key);
    if (answered) continue; // done — all further comments ignored (spec §7.2)

    // Consider only comments after the gate (or the re-prompt, if one is up).
    const windowStart = Math.max(gateIdx, repromptIdx);
    let resolved = false;
    for (let i = windowStart + 1; i < comments.length && !resolved; i++) {
      const c = comments[i]!;
      if (
        !(ACCEPTED_AUTHOR_ASSOCIATIONS as readonly string[]).includes(
          c.authorAssociation,
        )
      ) {
        continue;
      }
      if (anyHarnessMarker(c.body)) continue;

      const outcome = parseReply(c.body, fields);
      if (outcome.status === "chatter") continue;

      let faults = outcome.faults ?? [];
      if (outcome.status === "answer") {
        const v = validateAnswer(step.request.answerSchema, outcome.answer!);
        if (v.ok) {
          out.gateReplies.push({
            issue: step.issue,
            runId: step.runId,
            stepId: step.stepId,
            answer: outcome.answer!,
          });
          resolved = true;
          break;
        }
        faults = v.faults;
      }

      // Malformed (parse fault or ajv miss).
      if (repromptAttempt >= GATE_REPROMPT_LIMIT) {
        out.gateFailures.push({
          issue: step.issue,
          runId: step.runId,
          stepId: step.stepId,
          broke: `two replies to the \`${step.stepId}\` gate could not be turned into a schema-valid answer (${faults.join("; ")})`,
        });
      } else {
        out.gateReprompts.push({
          issue: step.issue,
          runId: step.runId,
          stepId: step.stepId,
          attempt: repromptAttempt + 1,
          faults,
          fields,
        });
      }
      resolved = true;
    }
  }

  return out;
}
