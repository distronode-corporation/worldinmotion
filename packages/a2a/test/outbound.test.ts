import type { ServerResponse } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { MAX_RESULT_BYTES, OutboundBridge, RemoteAgent, type OutboundOptions } from "../src/outbound.ts";
import { agentCard, clock, FakeMesh, json, serve, TOKEN, until } from "./helpers.ts";

type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { raw: (res: ServerResponse, id: unknown) => void };

interface Call {
  method: string;
  params: any;
  headers: Record<string, string | string[] | undefined>;
}

/** A fake external A2A agent: an agent card plus a JSON-RPC endpoint at /rpc. */
async function fakeAgent(
  onRpc: (method: string, params: any) => Reply | Promise<Reply>,
  card?: (base: string) => unknown,
) {
  let base = "";
  const calls: Call[] = [];
  const srv = await serve(async (req, res) => {
    if (req.method === "GET" && req.path === "/.well-known/agent-card.json") {
      return json(res, 200, card === undefined ? agentCard(`${base}/rpc`) : card(base));
    }
    if (req.method === "POST" && req.path === "/rpc") {
      const b = JSON.parse(req.body) as { id: unknown; method: string; params: unknown };
      calls.push({ method: b.method, params: b.params, headers: req.headers });
      const r = await onRpc(b.method, b.params);
      if ("raw" in r) return r.raw(res, b.id);
      return json(res, 200, { jsonrpc: "2.0", id: b.id, ...r });
    }
    json(res, 404, {});
  });
  base = srv.base;
  return { ...srv, calls, cardUrl: `${srv.base}/.well-known/agent-card.json` };
}

const task = (state: string, extra: Record<string, unknown> = {}) => ({
  task: { id: "remote-1", contextId: "c", status: { state }, ...extra },
});
const said = (text: string) => ({ messageId: "s", role: "ROLE_AGENT", parts: [{ text }] });

function remote(cardUrl: string, opts: Partial<OutboundOptions> = {}, authHeaderEnv?: string) {
  return new RemoteAgent(
    { name: "weather", cardUrl, authHeaderEnv },
    { mesh: new FakeMesh(), agents: [], pollIntervalMs: 5, requestTimeoutMs: 1000, ...opts },
  );
}

const soon = () => Date.now() + 5000;

describe("RemoteAgent.run", () => {
  it("sends the text with SendMessage, polls GetTask, and returns the artifact text", async () => {
    let polls = 0;
    const a = await fakeAgent((method) => {
      if (method === "SendMessage") return { result: task("TASK_STATE_SUBMITTED") };
      polls += 1;
      if (polls < 3) return { result: task("TASK_STATE_WORKING").task };
      return {
        result: task("TASK_STATE_COMPLETED", {
          artifacts: [
            { artifactId: "a1", parts: [{ text: "Sunny." }] },
            { artifactId: "a2", parts: [{ text: "High of 20." }] },
          ],
        }).task,
      };
    });
    const out = await remote(a.cardUrl, { env: { WEATHER_AUTH: "Bearer remote-secret" } }, "WEATHER_AUTH").run(
      "weather in Paris?",
      soon(),
    );
    expect(out).toEqual({ status: "done", text: "Sunny.\n\nHigh of 20." });
    expect(a.calls.map((c) => c.method)).toEqual(["SendMessage", "GetTask", "GetTask", "GetTask"]);
    expect(a.calls[0]!.params).toEqual({
      message: { messageId: expect.any(String), role: "ROLE_USER", parts: [{ text: "weather in Paris?", mediaType: "text/plain" }] },
      configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"], historyLength: 0 },
    });
    expect(a.calls[1]!.params).toEqual({ id: "remote-1", historyLength: 0 });
    for (const c of a.calls) {
      expect(c.headers["a2a-version"]).toBe("1.0");
      expect(c.headers["content-type"]).toBe("application/json");
      expect(c.headers.authorization).toBe("Bearer remote-secret");
    }
    expect(a.seen[0]!.headers.authorization).toBe("Bearer remote-secret");
  });

  it("sends no auth header when none is configured", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("hi") } }));
    expect(await remote(a.cardUrl).run("x", soon())).toEqual({ status: "done", text: "hi" });
    expect(a.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("maps every finished or interrupted remote state", async () => {
    const cases: Array<[unknown, { status: string; text: string }]> = [
      [task("TASK_STATE_COMPLETED", { status: { state: "TASK_STATE_COMPLETED", message: said("Done here.") } }), { status: "done", text: "Done here." }],
      [task("TASK_STATE_COMPLETED"), { status: "done", text: "" }],
      [
        task("TASK_STATE_COMPLETED", { artifacts: [{ artifactId: "a", parts: [{ text: "chart:" }, { url: "https://x/c.png" }] }] }),
        { status: "done", text: "chart:\n\n[1 non-text part omitted]" },
      ],
      [
        task("TASK_STATE_COMPLETED", { artifacts: [{ artifactId: "a", parts: [{ raw: "AA" }, { data: {} }] }] }),
        { status: "done", text: "[2 non-text parts omitted]" },
      ],
      [task("TASK_STATE_FAILED", { status: { state: "TASK_STATE_FAILED", message: said("Quota.") } }), { status: "failed", text: "Quota." }],
      [task("TASK_STATE_FAILED"), { status: "failed", text: "The agent reported a failure." }],
      [task("TASK_STATE_REJECTED", { status: { state: "TASK_STATE_REJECTED", message: said("No.") } }), { status: "declined", text: "No." }],
      [task("TASK_STATE_CANCELED"), { status: "failed", text: "The agent canceled the task." }],
      [
        task("TASK_STATE_CANCELED", { status: { state: "TASK_STATE_CANCELED", message: said("Shutting down.") } }),
        { status: "failed", text: "The agent canceled the task. Shutting down." },
      ],
      [task("TASK_STATE_INPUT_REQUIRED"), { status: "failed", text: "The agent asked for more input, which the gateway cannot relay." }],
      [
        task("TASK_STATE_AUTH_REQUIRED", { status: { state: "TASK_STATE_AUTH_REQUIRED", message: said("Log in first.") } }),
        { status: "failed", text: "The agent asked for more input, which the gateway cannot relay. Log in first." },
      ],
    ];
    for (const [reply, want] of cases) {
      const a = await fakeAgent(() => ({ result: reply }));
      expect(await remote(a.cardUrl).run("x", soon())).toEqual(want);
    }
  });

  it("cancels the remote task and reports a timeout at the deadline", async () => {
    const a = await fakeAgent((method) =>
      method === "CancelTask"
        ? { result: task("TASK_STATE_CANCELED").task }
        : { result: method === "SendMessage" ? task("TASK_STATE_WORKING") : task("TASK_STATE_WORKING").task },
    );
    const out = await remote(a.cardUrl).run("slow", Date.now() + 60);
    expect(out).toEqual({ status: "timeout", text: "weather did not finish before the deadline." });
    expect(a.calls.at(-1)).toMatchObject({ method: "CancelTask", params: { id: "remote-1" } });
  });

  it("still reports the timeout when the cancel fails", async () => {
    const a = await fakeAgent((method) =>
      method === "CancelTask" ? { error: { code: -32002, message: "Task not cancelable" } } : { result: task("TASK_STATE_WORKING") },
    );
    expect((await remote(a.cardUrl).run("slow", Date.now() - 1)).status).toBe("timeout");
    expect(a.calls.map((c) => c.method)).toEqual(["SendMessage", "CancelTask"]);
  });

  it("turns a JSON-RPC error into a failed result, naming the task when there is one", async () => {
    const a = await fakeAgent(() => ({ error: { code: -32005, message: "Content type not supported" } }));
    expect(await remote(a.cardUrl).run("x", soon())).toEqual({
      status: "failed",
      text: "weather answered with an error: -32005 Content type not supported",
    });
    const b = await fakeAgent((method) =>
      method === "SendMessage" ? { result: task("TASK_STATE_WORKING") } : { error: { code: -32001, message: "x".repeat(5000) } },
    );
    const out = await remote(b.cardUrl).run("x", soon());
    expect(out.status).toBe("failed");
    expect(out.text).toMatch(/^weather answered with an error: -32001 x+ \[truncated\] \(task remote-1\)$/);
    expect(out.text.length).toBeLessThan(1100);
  });

  it("refuses responses that do not follow the spec", async () => {
    const bad: Reply[] = [
      { result: { nothing: true } },
      { raw: (res) => json(res, 500, { oops: true }) },
      { raw: (res) => json(res, 200, { jsonrpc: "2.0", id: "someone-else", result: task("TASK_STATE_COMPLETED") }) },
    ];
    const want = [
      "weather failed: SendMessage answered with neither a task nor a message",
      "weather failed: not a JSON-RPC response (HTTP 500)",
      "weather failed: not a JSON-RPC response (HTTP 200)",
    ];
    for (const [i, reply] of bad.entries()) {
      const a = await fakeAgent(() => reply);
      expect(await remote(a.cardUrl).run("x", soon())).toEqual({ status: "failed", text: want[i] });
    }
    const swapped = await fakeAgent((method) =>
      method === "SendMessage" ? { result: task("TASK_STATE_WORKING") } : { result: { id: "other", status: { state: "TASK_STATE_COMPLETED" } } },
    );
    expect(await remote(swapped.cardUrl).run("x", soon())).toEqual({
      status: "failed",
      text: "weather failed: GetTask answered with another or no task (task remote-1)",
    });
  });

  it("fails on an oversize response, a redirected POST, and a slow agent", async () => {
    const big = await fakeAgent(() => ({ raw: (res) => json(res, 200, { pad: "x".repeat(1024 * 1024) }) }));
    expect((await remote(big.cardUrl).run("x", soon())).text).toBe("weather failed: response larger than 1048576 bytes");
    const moved = await fakeAgent(() => ({
      raw: (res) => {
        res.writeHead(307, { location: "/rpc2" });
        res.end();
      },
    }));
    expect((await remote(moved.cardUrl).run("x", soon())).text).toBe("weather failed: redirect refused for a POST");
    const slow = await fakeAgent(() => ({ raw: () => {} }));
    expect((await remote(slow.cardUrl, { requestTimeoutMs: 50 }).run("x", soon())).text).toBe(
      "weather failed: timed out after 50 ms",
    );
  });

  it("passes the interface tenant on every call", async () => {
    const a = await fakeAgent(
      () => ({ result: { message: said("ok") } }),
      (base) => agentCard(`${base}/rpc`, { supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "t-7" }] }),
    );
    await remote(a.cardUrl).run("x", soon());
    expect(a.calls[0]!.params.tenant).toBe("t-7");
  });
});

describe("agent card checks", () => {
  const unusable = (why: string) => ({ status: "failed", text: `The agent card for weather is unusable: ${why}` });

  it("refuses a card that is missing, malformed, or offers no usable interface", async () => {
    const cards: Array<[(base: string) => unknown, string]> = [
      [() => ({ name: "x" }), "not an A2A agent card"],
      [(b) => agentCard(`${b}/rpc`, { supportedInterfaces: [{ url: `${b}/rpc`, protocolBinding: "GRPC", protocolVersion: "1.0" }] }), "no JSONRPC interface for protocol 1.0"],
      [(b) => agentCard(`${b}/rpc`, { supportedInterfaces: [{ url: `${b}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "0.3" }] }), "no JSONRPC interface for protocol 1.0"],
      [() => agentCard("http://agent.example/rpc"), "URL must be https, or http to a loopback host"],
      [(b) => agentCard(b.replace("127.0.0.1", "localhost") + "/rpc"), "interface is on another host (localhost:PORT)"],
      [(b) => agentCard(`${b}/rpc`, { defaultInputModes: ["image/png"] }), "the agent does not accept text"],
    ];
    for (const [card, why] of cards) {
      const a = await fakeAgent(() => ({ result: { message: said("never") } }), card);
      expect(await remote(a.cardUrl).run("x", soon())).toEqual(unusable(why.replace("PORT", String(a.port))));
      expect(a.calls).toHaveLength(0);
    }
    const gone = await serve((_req, res) => json(res, 404, { error: "no card" }));
    expect(await remote(`${gone.base}/.well-known/agent-card.json`).run("x", soon())).toEqual(unusable("HTTP 404"));
  });

  it("accepts text input modes in their common spellings", async () => {
    for (const mode of ["text", "text/markdown", "*/*"]) {
      const a = await fakeAgent(() => ({ result: { message: said("ok") } }), (b) => agentCard(`${b}/rpc`, { defaultInputModes: ["image/png", mode] }));
      expect((await remote(a.cardUrl).run("x", soon())).status).toBe("done");
    }
  });

  it("follows a same-origin card redirect and refuses one to another host", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("ok") } }));
    const redirector = await serve((req, res) => {
      res.writeHead(302, { location: req.path === "/here" ? "/.well-known/agent-card.json" : a.cardUrl });
      res.end();
    });
    expect((await remote(`${redirector.base}/away`).run("x", soon())).text).toMatch(
      /^The agent card for weather is unusable: redirect to another host refused/,
    );
    expect(a.seen).toHaveLength(0);
    // Same scheme, host and port is required: a different port is another origin.
    const hop = await serve((_req, res) => {
      res.writeHead(301, { location: a.cardUrl });
      res.end();
    });
    expect((await remote(`${hop.base}/x`).run("x", soon())).status).toBe("failed");
    let base = "";
    const self = await serve((req, res) => {
      if (req.path === "/old") {
        res.writeHead(302, { location: "/.well-known/agent-card.json" });
        res.end();
      } else if (req.method === "GET") json(res, 200, agentCard(`${base}/rpc`));
      else json(res, 200, { jsonrpc: "2.0", id: JSON.parse(req.body).id, result: { message: said("moved ok") } });
    });
    base = self.base;
    expect(await remote(`${self.base}/old`).run("x", soon())).toEqual({ status: "done", text: "moved ok" });
  });

  it("caches the card for cardTtlMs", async () => {
    const c = clock();
    const a = await fakeAgent(() => ({ result: { message: said("ok") } }));
    const r = remote(a.cardUrl, { now: c.now, cardTtlMs: 1000 });
    await r.run("1", Number.MAX_SAFE_INTEGER);
    await r.run("2", Number.MAX_SAFE_INTEGER);
    expect(a.seen.filter((s) => s.method === "GET")).toHaveLength(1);
    c.advance(1000);
    await r.run("3", Number.MAX_SAFE_INTEGER);
    expect(a.seen.filter((s) => s.method === "GET")).toHaveLength(2);
  });

  it("needs its auth variable at construction, from process.env by default", () => {
    expect(() => remote("https://agent.example/card", { env: {} }, "WEATHER_AUTH")).toThrow(
      "environment variable WEATHER_AUTH is not set",
    );
    expect(() => remote("https://agent.example/card", { env: { WEATHER_AUTH: "" } }, "WEATHER_AUTH")).toThrow("is not set");
    vi.stubEnv("WIM_TEST_WEATHER_AUTH", "Bearer from-process-env");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    expect(() => new RemoteAgent({ name: "w", cardUrl: "https://agent.example/card", authHeaderEnv: "WIM_TEST_WEATHER_AUTH" }, { mesh: new FakeMesh(), agents: [] })).not.toThrow();
    expect(() => remote("http://agent.example/card")).toThrow("URL must be https");
  });
});

describe("OutboundBridge", () => {
  function bridge(cardUrl: string, mesh = new FakeMesh(), opts: Partial<OutboundOptions> = {}) {
    const logs: string[] = [];
    const b = new OutboundBridge({
      mesh,
      agents: [{ name: "weather", cardUrl }],
      pollIntervalMs: 5,
      log: (l) => logs.push(l),
      ...opts,
    });
    b.start();
    return { b, mesh, logs };
  }

  it("lists its sessions as kind a2a and refuses duplicate names", () => {
    const { b } = bridge("https://agent.example/card");
    expect(b.sessions()).toEqual([{ name: "weather", kind: "a2a" }]);
    expect(
      () =>
        new OutboundBridge({
          mesh: new FakeMesh(),
          agents: [
            { name: "w", cardUrl: "https://a.example/c" },
            { name: "w", cardUrl: "https://b.example/c" },
          ],
        }),
    ).toThrow("external agent w is listed twice");
  });

  it("answers a mesh task with a result to its sender", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("It is sunny.") } }));
    const { mesh, logs } = bridge(a.cardUrl);
    mesh.task({ id: "01TASK", to: "weather@gw", from: "reviewer@laptop", text: "weather?", deadline: Date.now() + 5000 });
    const r = await until(() => mesh.results[0]);
    expect(r).toEqual({ to: "reviewer@laptop", taskId: "01TASK", status: "done", text: "It is sunny." });
    expect(logs).toEqual(["a2a: task 01TASK from reviewer@laptop to external agent weather"]);
    expect(logs.join()).not.toContain("weather?");
  });

  it("relays a plain msg too, and ignores items for other sessions", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("hello back") } }));
    const { mesh } = bridge(a.cardUrl);
    mesh.task({ id: "01OTHER", to: "reviewer@laptop", from: "x@y", text: "not ours" });
    mesh.message({ id: "01MSG", to: "weather", from: "helper@laptop", text: "hello" });
    const r = await until(() => mesh.results[0]);
    expect(r).toEqual({ to: "helper@laptop", taskId: "01MSG", status: "done", text: "hello back" });
    expect(mesh.results).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
  });

  it("starts on a mesh port without onMessage", () => {
    const mesh = new FakeMesh();
    (mesh as { onMessage?: unknown }).onMessage = undefined;
    expect(() => bridge("https://agent.example/card", mesh)).not.toThrow();
  });

  it("declines past the concurrency cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = await fakeAgent(async () => {
      await gate;
      return { result: { message: said("ok") } };
    });
    const { b, mesh } = bridge(a.cardUrl, new FakeMesh(), { maxConcurrent: 1 });
    const first = b.relay("01A", "weather@gw", "p@d", "one", Date.now() + 5000);
    await until(() => (a.calls.length === 1 ? true : undefined));
    await b.relay("01B", "weather@gw", "p@d", "two");
    expect(mesh.results[0]).toEqual({ to: "p@d", taskId: "01B", status: "declined", text: "weather is busy with 1 tasks; try again later." });
    release();
    await first;
    await b.relay("01C", "weather@gw", "p@d", "three");
    expect(mesh.results.map((r) => r.status)).toEqual(["declined", "done", "done"]);
  });

  it("pulls a far deadline in to maxDeadlineMs, and uses the default when there is none", async () => {
    const c = clock(Date.now());
    const a = await fakeAgent((method) => ({
      result: method === "SendMessage" ? task("TASK_STATE_WORKING") : task("TASK_STATE_WORKING").task,
    }));
    const { b, mesh } = bridge(a.cardUrl, new FakeMesh(), { now: c.now, maxDeadlineMs: 30, defaultDeadlineMs: 20 });
    // With a hand-wound clock that never moves the poll loop would run forever; jump it instead.
    const p = b.relay("01FAR", "weather@gw", "p@d", "x", c.now() + 10_000_000);
    await until(() => (a.calls.length >= 2 ? true : undefined));
    c.advance(31);
    await p;
    expect(mesh.results[0]!.status).toBe("timeout");
    const q = b.relay("01DEF", "weather@gw", "p@d", "x");
    await until(() => (a.calls.filter((x) => x.method === "SendMessage").length === 2 ? true : undefined));
    c.advance(21);
    await q;
    expect(mesh.results[1]!.status).toBe("timeout");
  });

  it("clips a result past the mesh text limit", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("é".repeat(MAX_RESULT_BYTES)) } }));
    const { b, mesh } = bridge(a.cardUrl);
    await b.relay("01BIG", "weather@gw", "p@d", "x", Date.now() + 5000);
    const text = mesh.results[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(text.endsWith(" [truncated]")).toBe(true);
  });

  it("logs a result the mesh would not take", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("ok") } }));
    const mesh = new FakeMesh();
    mesh.sendResultError = new Error("queue full");
    const { b, logs } = bridge(a.cardUrl, mesh);
    await b.relay("01X", "weather@gw", "p@d", "x");
    expect(logs).toContain("a2a: result for 01X not sent: queue full");
  });

  it("never sends the inbound bearer token to an external agent", async () => {
    const a = await fakeAgent(() => ({ result: { message: said("ok") } }));
    const { b } = bridge(a.cardUrl);
    await b.relay("01T", "weather@gw", "p@d", `the token is not here`);
    for (const s of a.seen) expect(JSON.stringify(s.headers)).not.toContain(TOKEN);
  });

  it("uses stderr and the real clock by default", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    onTestFinished(() => write.mockRestore());
    const a = await fakeAgent(() => ({ result: { message: said("ok") } }));
    const mesh = new FakeMesh();
    const b = new OutboundBridge({ mesh, agents: [{ name: "weather", cardUrl: a.cardUrl }] });
    await b.relay("01D", "weather@gw", "p@d", "x");
    expect(mesh.results[0]!.status).toBe("done");
    expect(write).toHaveBeenCalledWith("a2a: task 01D from p@d to external agent weather\n");
  });
});
