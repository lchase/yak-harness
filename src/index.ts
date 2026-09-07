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
  GatePendingRequestSchema,
  StepFailureSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  JournalEventSchema,
  type GatePendingRequest,
  type StepFailure,
  type RunStartedEvent,
  type RunFinishedEvent,
  type JournalEvent,
} from "./yak-schemas.js";
