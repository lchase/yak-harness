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
export { buildWorkflowGraph, layoutWorkflow } from "./dashboard/graph.js";
export { type RenderOptions, renderDashboard } from "./dashboard/render.js";
export { parseEnvelopes, replayRun } from "./dashboard/replay.js";
export {
  createDashboardServer,
  handleRequest,
  type ServeOptions,
  serveDashboard,
} from "./dashboard/serve.js";
export {
  buildDashboardModel,
  type DashboardDeps,
  type DashboardModel,
  detectDrift,
  type RunView,
  realDashboardDeps,
  runDashboard,
} from "./dashboard.js";
export {
  type CheckResult,
  type DoctorDeps,
  type DoctorReport,
  formatReport,
  realDoctorDeps,
  runDoctor,
} from "./doctor.js";
export {
  contractLines,
  type GateFailure,
  type GateField,
  type GateReply,
  type GateReprompt,
  gateCommentBody,
  parseReply,
  readFields,
  repromptCommentBody,
  resolveGates,
  schemaSha,
  validateAnswer,
} from "./gate-bridge.js";
export { acquireTickLock, LockHeld, type TickLock } from "./lock.js";
export {
  classifyRun,
  findOrphans,
  findStaleMarkers,
  type GateRequest,
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
  parseFailedMarkers,
  parseJournal,
  parseMarkers,
  prStateFrom,
  type RawComment,
  type RawIssue,
  type RawPendingRun,
  type RawPr,
  type RunBreadcrumb,
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
  parsePrListJson,
  parsePrViewJson,
  parseRunBreadcrumb,
  prUrlLooksValid,
  runIdIsSafe,
  scanPendingRuns,
} from "./observe-deps.js";
export {
  type Action,
  deriveObserved,
  escalationDetail,
  type FlagOrphanAction,
  type LaunchRunAction,
  type PostGateCommentAction,
  type PostGateRepromptAction,
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
export { appendTickLog, type TickLogRecord } from "./tick-log.js";
export {
  CURRENT_STATUS_VALUES,
  type CurrentStatus,
  launchTarget,
  OBSERVED_VALUES,
  type Observed,
  type Transition,
  transition,
} from "./transition.js";
export {
  BUNDLED_WORKFLOWS_DIR,
  resolveWorkflowPath,
  WorkflowResolutionError,
} from "./workflow-path.js";
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
