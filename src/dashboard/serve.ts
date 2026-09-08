// `yak-harness dashboard --serve` — a live local monitor.
//
// A tiny loopback HTTP server (Node's own `http`, zero deps). Every
// request runs the *whole* dashboard pass from scratch — `observe()` the
// same truth the tick reads (GitHub via `gh`, `.runs/` journals +
// `workflow.json` + artifacts off disk), replay, render. Nothing is
// cached and nothing is held between requests: kill it, restart it, hit
// it an hour later — the next request reconstructs the identical view.
// That is the point — it mirrors the reconciler's own statelessness
// (docs/design/dashboard.md).
//
// Two routes: `/` serves the full page plus a small poll script; the
// script re-fetches `/fragment` (the `.wrap` inner HTML only) every
// `--interval` seconds and swaps it in without moving the scroll
// position.
//
// Read-only and tick-independent: no lock, no `tick.log`, no writes to
// GitHub / yak / `.harness/`. Binds `127.0.0.1` by default.

import { createServer, type Server } from "node:http";
import type { Config } from "../config.js";
import { runDashboard } from "../dashboard.js";
import { ObserveError, realObserveDeps } from "../observe.js";
import { realDashboardDeps } from "./deps.js";

export interface ServeOptions {
  port: number;
  /** Interface to bind. Loopback by default — this is a local monitor. */
  host: string;
  /** Poll cadence, seconds. Clamped to >= 2. */
  intervalSeconds: number;
}

export interface ServeIo {
  out(text: string): void;
  err(text: string): void;
}

interface Response {
  status: number;
  type: string;
  body: string;
}

/**
 * Map one request path to a response. `render(fragment)` produces the
 * full page (`fragment: false`) or just the `.wrap` inner HTML
 * (`fragment: true`). Pure apart from calling `render`; unit-tested
 * directly.
 */
export function handleRequest(
  path: string,
  render: (fragment: boolean) => string,
): Response {
  const url = path.split("?", 1)[0];
  if (url === "/favicon.ico")
    return { status: 204, type: "text/plain", body: "" };
  const fragment = url === "/fragment";
  if (!fragment && url !== "/" && url !== "/index.html")
    return { status: 404, type: "text/plain", body: "not found\n" };
  try {
    return {
      status: 200,
      type: "text/html; charset=utf-8",
      body: render(fragment),
    };
  } catch (err) {
    const detail = err instanceof ObserveError ? err.message : String(err);
    return {
      status: 500,
      type: "text/plain; charset=utf-8",
      body: `dashboard could not render this tick:\n\n${detail}\n\nthe server is still up — it will retry on the next refresh\n`,
    };
  }
}

/** An HTTP server that answers every request with a fresh `render(fragment)`. */
export function createDashboardServer(
  render: (fragment: boolean) => string,
): Server {
  return createServer((req, res) => {
    const { status, type, body } = handleRequest(req.url ?? "/", render);
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
    });
    res.end(body);
  });
}

/**
 * Start the live server. Returns a promise that resolves (with `0`) only
 * once the server has been asked to stop — on `SIGINT` / `SIGTERM`, or if
 * `listen` fails. The CLI awaits it so the process stays alive.
 */
export function serveDashboard(
  config: Config,
  opts: ServeOptions,
  io: ServeIo,
): Promise<number> {
  const interval = Math.max(2, Math.floor(opts.intervalSeconds));
  const render = (fragment: boolean): string =>
    runDashboard(
      config,
      {
        observe: realObserveDeps(config),
        dashboard: realDashboardDeps(config),
      },
      { refreshSeconds: interval, fragment },
    );

  return new Promise<number>((resolve) => {
    const server = createDashboardServer(render);

    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      io.err(`\n${signal} — stopping (nothing to clean up)`);
      server.close(() => resolve(0));
    };

    server.on("error", (err) => {
      io.err(`dashboard server error: ${String(err)}`);
      resolve(1);
    });

    server.listen(opts.port, opts.host, () => {
      io.out(
        `yak-harness monitor on http://${opts.host}:${opts.port}  (refresh ${interval}s, Ctrl-C to stop)`,
      );
    });

    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
  });
}
