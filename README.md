# yak-harness

Stateless cron reconciler that runs a GitHub Issues backlog through
[yak](https://github.com/lchase/yak): a `yak run` per labelled issue, a
status-label state machine, and yak's gate prompts bridged into issue
comments. yak's engine stays entirely ignorant that GitHub exists.

**Status:** design complete, not yet implemented.

- **[`docs/spec.md`](docs/spec.md)** — the spec. Start here.
- **[`docs/design/`](docs/design/)** — the wayfinder decision trail the
  spec was distilled from: the map, seven decision tickets, and the
  gate-bridge prototype.

Companion yak-engine requests (non-blocking): lchase/yak
[#22](https://github.com/lchase/yak/issues/22),
[#23](https://github.com/lchase/yak/issues/23),
[#24](https://github.com/lchase/yak/issues/24).
