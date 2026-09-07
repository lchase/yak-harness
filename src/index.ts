// yak-harness — public entry point.
// Implementation follows docs/spec.md §13. Ticket #2: config + doctor +
// yak boundary schemas.
export const VERSION = "0.0.0";

export {
  type ApplyDeps,
  ApplyError,
  type ApplyResult,
  apply,
  branchForRun,
  realApplyDeps,
  renderInput,
  type SpawnedRun,
} from "./apply.js";
export {
  type Config,
  ConfigError,
  ConfigSchema,
  loadConfig,
} from "./config.js";
export * as constants from "./constants.js";
export {
  type CheckResult,
  type DoctorDeps,
  type DoctorReport,
  formatReport,
  realDoctorDeps,
  runDoctor,
} from "./doctor.js";
export {
  classifyRun,
  findOrphans,
  findStaleMarkers,
  type GateReply,
  type IssueObservation,
  type LinkageFault,
  linkMarkers,
  type Observation,
  type ObserveDeps,
  ObserveError,
  type Orphan,
  observe,
  type PendingRun,
  type PendingStep,
  type PrState,
  parseJournal,
  parseMarkers,
  prStateFrom,
  type RawComment,
  type RawIssue,
  type RawPendingRun,
  type RawPr,
  type RunClass,
  type RunMarker,
  type RunObservation,
  readLabels,
  realObserveDeps,
  type StaleMarker,
} from "./observe.js";
export {
  branchIsSafe,
  issueLabelSearch,
  parseCommentsJson,
  parseIssueListJson,
  parsePendingJson,
  parsePrListJson,
  parsePrViewJson,
  prUrlLooksValid,
  runIdIsSafe,
} from "./observe-deps.js";
export {
  type Action,
  deriveObserved,
  type FlagOrphanAction,
  type LaunchRunAction,
  type PostGateCommentAction,
  plan,
  type RelabelAction,
  type WriteAnswerAndResumeAction,
} from "./plan.js";
export {
  describeAction,
  runTick,
  type TickDeps,
  type TickIo,
  type TickOptions,
} from "./tick.js";
export {
  CURRENT_STATUS_VALUES,
  type CurrentStatus,
  OBSERVED_VALUES,
  type Observed,
  type Transition,
  transition,
} from "./transition.js";
export {
  type GatePendingRequest,
  GatePendingRequestSchema,
  type JournalEvent,
  JournalEventSchema,
  KNOWN_STEP_FAILURE_REASONS,
  RUN_FINISHED_KNOWN_STATUSES,
  type RunFinishedEvent,
  RunFinishedEventSchema,
  type RunStartedEvent,
  RunStartedEventSchema,
  type StepFailedEvent,
  StepFailedEventSchema,
  type StepFailure,
  StepFailureSchema,
} from "./yak-schemas.js";
