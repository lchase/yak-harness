// yak-harness CLI entry.
//
// Surface (docs/spec.md §10.2):
//   yak-harness tick   --config <path> [--dry-run]
//   yak-harness doctor --config <path>
//
// Scaffold only — no command is implemented yet.

const [command] = process.argv.slice(2);

switch (command) {
  case "tick":
  case "doctor":
    console.error(`yak-harness: "${command}" not implemented yet`);
    process.exit(1);
    break;
  default:
    console.error("usage: yak-harness <tick|doctor> --config <path> [--dry-run]");
    process.exit(2);
}
