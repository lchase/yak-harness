// Pull human-readable run context out of yak's on-disk artifacts
// (`.runs/<id>/artifacts/<name>.json`) for the dashboard.
//
// Same tolerance rule as replay.ts / graph.ts: a missing or malformed
// artifact yields `null` and the card just shows less. The dashboard is
// a spectator — it never depends on an artifact being present or on its
// exact shape.

/** The `assess` step's artifact in the `implement-change` workflow. */
export interface Assessment {
  kind?: string;
  confidence?: number;
  needsDesign?: boolean;
  needsDocs?: boolean;
  likelySubtasks?: number;
  /** One paragraph: what the change is and where it goes. The useful bit. */
  summary?: string;
}

function asRecord(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse an `assessment` artifact, keeping only fields of the expected type. */
export function parseAssessment(text: string | null): Assessment | null {
  const r = asRecord(text);
  if (!r) return null;
  const out: Assessment = {};
  if (typeof r.kind === "string") out.kind = r.kind;
  if (typeof r.confidence === "number") out.confidence = r.confidence;
  if (typeof r.needsDesign === "boolean") out.needsDesign = r.needsDesign;
  if (typeof r.needsDocs === "boolean") out.needsDocs = r.needsDocs;
  if (typeof r.likelySubtasks === "number")
    out.likelySubtasks = r.likelySubtasks;
  if (typeof r.summary === "string" && r.summary.trim())
    out.summary = r.summary.trim();
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse a `plan` artifact's checklist (`{ steps: string[] }`). */
export function parsePlanSteps(text: string | null): string[] | null {
  const r = asRecord(text);
  const steps = r?.steps;
  if (!Array.isArray(steps)) return null;
  const out = steps.filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  return out.length > 0 ? out : null;
}
