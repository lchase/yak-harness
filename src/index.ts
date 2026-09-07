// yak-harness — public entry point.
// Implementation follows docs/spec.md §13. Ticket #2: config + doctor +
// yak boundary schemas.
export const VERSION = "0.0.0";

export { ConfigSchema, ConfigError, loadConfig, type Config } from "./config.js";
export {
  runDoctor,
  formatReport,
  realDoctorDeps,
  type DoctorDeps,
  type DoctorReport,
  type CheckResult,
} from "./doctor.js";
export * as constants from "./constants.js";
export {
  observe,
  realObserveDeps,
  ObserveError,
  classifyRun,
  parseJournal,
  parseMarkers,
  readLabels,
  prStateFrom,
  linkMarkers,
  findOrphans,
  findStaleMarkers,
  type Observation,
  type ObserveDeps,
  type IssueObservation,
  type RunObservation,
  type PendingRun,
  type PendingStep,
  type Orphan,
  type StaleMarker,
  type LinkageFault,
  type RunMarker,
  type RunClass,
  type PrState,
  type RawIssue,
  type RawComment,
  type RawPendingRun,
  type RawPr,
} from "./observe.js";
export {
  runIdIsSafe,
  branchIsSafe,
  prUrlLooksValid,
  issueLabelSearch,
  parseIssueListJson,
  parseCommentsJson,
  parsePrViewJson,
  parsePrListJson,
  parsePendingJson,
} from "./observe-deps.js";
export {
  GatePendingRequestSchema,
  StepFailureSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  StepFailedEventSchema,
  JournalEventSchema,
  KNOWN_STEP_FAILURE_REASONS,
  RUN_FINISHED_KNOWN_STATUSES,
  type GatePendingRequest,
  type StepFailure,
  type RunStartedEvent,
  type RunFinishedEvent,
  type StepFailedEvent,
  type JournalEvent,
} from "./yak-schemas.js";
