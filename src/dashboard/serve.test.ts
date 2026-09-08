import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer, handleRequest } from "./serve.js";

const render = (fragment: boolean) =>
  fragment ? "<b>frag</b>" : "<html>full</html>";

describe("handleRequest", () => {
  it("serves the full page at / and /index.html", () => {
    const r = handleRequest("/", render);
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.body).toBe("<html>full</html>");
    expect(handleRequest("/index.html?x=1", render).body).toBe(
      "<html>full</html>",
    );
  });

  it("serves the body-only fragment at /fragment", () => {
    const r = handleRequest("/fragment", render);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<b>frag</b>");
  });

  it("204s the favicon and 404s anything else", () => {
    expect(handleRequest("/favicon.ico", render).status).toBe(204);
    expect(handleRequest("/other", render).status).toBe(404);
  });

  it("turns a render failure into a 500 and keeps serving", () => {
    const r = handleRequest("/", () => {
      throw new Error("gh exploded");
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain("gh exploded");
    expect(r.body).toContain("retry on the next refresh");
  });
});

describe("createDashboardServer", () => {
  const servers: import("node:http").Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("serves a fresh render on each request, page vs fragment", async () => {
    let n = 0;
    const server = createDashboardServer((frag) =>
      frag ? `frag #${++n}` : `page #${++n}`,
    );
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    expect(await fetch(`${base}/`).then((x) => x.text())).toBe("page #1");
    expect(await fetch(`${base}/fragment`).then((x) => x.text())).toBe(
      "frag #2",
    );
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
