import { request } from "node:http";
import { connect } from "node:net";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { InboundGateway, MAX_REQUEST_BYTES, MAX_TASK_TEXT_BYTES, type InboundOptions } from "../src/inbound.ts";
import { AgentCardSchema, TaskSchema, type Task } from "../src/spec.ts";
import { clock, FakeMesh, rawRequest, selfSignedTls, TOKEN, until } from "./helpers.ts";

interface Rpc {
  status: number;
  // The JSON-RPC envelope, loosely typed for assertions.
  body: { id: unknown; result?: any; error?: { code: number; message: string } };
}

async function setup(opts: Partial<InboundOptions> = {}) {
  const mesh = new FakeMesh();
  const logs: string[] = [];
  const gw = new InboundGateway({ mesh, token: TOKEN, log: (l) => logs.push(l), ...opts });
  const { url, port } = await gw.start();
  onTestFinished(() => gw.close());

  async function rpc(
    method: string,
    params?: unknown,
    o: { version?: string | null; auth?: string | null; id?: unknown; query?: string } = {},
  ): Promise<Rpc> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.auth !== null) headers.authorization = o.auth ?? `Bearer ${TOKEN}`;
    if (o.version !== null) headers["a2a-version"] = o.version ?? "1.0";
    const res = await fetch(`${url}${o.query ?? ""}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: o.id ?? 1, method, params }),
    });
    return { status: res.status, body: (await res.json()) as Rpc["body"] };
  }

  /** SendMessage with returnImmediately, to a peer, returning the task. */
  async function submit(text: string, to = "reviewer@laptop", extra: Record<string, unknown> = {}): Promise<Task> {
    const r = await rpc("SendMessage", {
      message: { messageId: `m-${Math.random()}`, role: "ROLE_USER", parts: [{ text }], metadata: { worldinmotion: { to } } },
      configuration: { returnImmediately: true },
      ...extra,
    });
    expect(r.body.error).toBeUndefined();
    return TaskSchema.parse(r.body.result.task);
  }

  return { mesh, logs, gw, url, port, rpc, submit };
}

function message(text: string, metadata?: Record<string, unknown>) {
  return { messageId: "msg-1", role: "ROLE_USER", parts: [{ text }], ...(metadata ? { metadata } : {}) };
}

describe("binding", () => {
  it("binds loopback by default and refuses other addresses unless allowed", async () => {
    const { url } = await setup();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const gw = new InboundGateway({ mesh: new FakeMesh(), token: TOKEN, host: "0.0.0.0" });
    await expect(gw.start()).rejects.toThrow("refusing to bind 0.0.0.0: set allowNonLoopback");
    const noTls = new InboundGateway({ mesh: new FakeMesh(), token: TOKEN, host: "0.0.0.0", allowNonLoopback: true });
    await expect(noTls.start()).rejects.toThrow("refusing to bind 0.0.0.0 without TLS: set tls");
    // Allowed with TLS, the bind is attempted; this TEST-NET address is on no interface, so it fails.
    const { cert, key } = selfSignedTls();
    const allowed = new InboundGateway({
      mesh: new FakeMesh(),
      token: TOKEN,
      host: "192.0.2.1",
      allowNonLoopback: true,
      tls: { cert, key },
    });
    await expect(allowed.start()).rejects.toThrow();
  });

  it("brackets an IPv6 host in its URL", async () => {
    const { url } = await setup({ host: "::1" });
    expect(url).toMatch(/^http:\/\/\[::1\]:\d+\/$/);
  });

  it("serves HTTPS when given a certificate", async () => {
    const { cert, key } = selfSignedTls();
    const { url } = await setup({ tls: { cert, key }, host: "127.0.0.1" });
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await rawRequest(`${url}.well-known/agent-card.json`, { headers: { authorization: `Bearer ${TOKEN}` }, ca: cert });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).supportedInterfaces[0].url).toBe(url);
  });

  it("closes cleanly before start and twice", async () => {
    const gw = new InboundGateway({ mesh: new FakeMesh(), token: TOKEN });
    await gw.close();
    await gw.start();
    await gw.close();
    await gw.close();
  });
});

describe("agent card", () => {
  it("needs the bearer token by default", async () => {
    const { url } = await setup();
    const res = await fetch(`${url}.well-known/agent-card.json`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("describes the gateway with one skill per reachable peer", async () => {
    const { url, port } = await setup();
    const res = await fetch(`${url}.well-known/agent-card.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("max-age=30");
    expect(res.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const card = AgentCardSchema.parse(await res.json());
    expect(card.supportedInterfaces).toEqual([
      { url: `http://127.0.0.1:${port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ]);
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false });
    expect(card.securitySchemes).toEqual({ bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } });
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
    // Offline peers and bridged A2A agents are left out.
    expect(card.skills.map((s) => s.id)).toEqual(["reviewer@laptop", "helper@laptop"]);
    expect(card.skills[1]).toMatchObject({ name: "helper@laptop", tags: ["worldinmotion", "bot"], inputModes: ["text/plain"] });
    expect(card.name).toBe("worldinmotion gateway");
  });

  it("can be public, with a public URL, name and description", async () => {
    const { url } = await setup({
      cardRequiresAuth: false,
      publicUrl: "https://gw.example/a2a",
      name: "Team mesh",
      description: "Our agents.",
    });
    const card = (await (await fetch(`${url}.well-known/agent-card.json`)).json()) as Record<string, unknown>;
    expect(card).toMatchObject({
      name: "Team mesh",
      description: "Our agents.",
      supportedInterfaces: [{ url: "https://gw.example/a2a" }],
    });
    // Public card or not, the RPC endpoint still needs the token.
    const rpc = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(rpc.status).toBe(401);
  });

  it("answers 405 to anything but GET, and 503 when the mesh is down", async () => {
    const { url, mesh, logs } = await setup();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${url}.well-known/agent-card.json`, { method: "POST", headers: auth })).status).toBe(405);
    mesh.peersError = new Error("relay unreachable");
    expect((await fetch(`${url}.well-known/agent-card.json`, { headers: auth })).status).toBe(503);
    expect(logs).toContain("a2a: agent card unavailable: relay unreachable");
  });
});

describe("Host header (DNS rebinding)", () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it("answers 421 to a Host that is not a configured name, before checking auth", async () => {
    const { url, port } = await setup();
    const card = `${url}.well-known/agent-card.json`;
    expect((await rawRequest(card, { headers: { ...auth, host: `localhost:${port}` } })).status).toBe(200);
    expect((await rawRequest(card, { headers: { ...auth, host: `127.0.0.1:${port}` } })).status).toBe(200);
    for (const host of [`rebind.attacker.example:${port}`, "127.0.0.2", "a b"]) {
      const r = await rawRequest(card, { headers: { ...auth, host } });
      expect(r.status).toBe(421);
      expect(JSON.parse(r.body)).toEqual({ error: "unknown host" });
    }
    expect((await rawRequest(card, { headers: { host: "rebind.attacker.example" } })).status).toBe(421);
  });

  it("refuses a request with no Host header", async () => {
    const { port } = await setup();
    const reply = await new Promise<string>((resolve) => {
      let got = "";
      const sock = connect(port, "127.0.0.1", () => sock.write(`GET /.well-known/agent-card.json HTTP/1.0\r\nauthorization: Bearer ${TOKEN}\r\n\r\n`));
      sock.on("data", (c) => (got += c.toString()));
      sock.on("end", () => resolve(got));
    });
    expect(reply.startsWith("HTTP/1.1 421")).toBe(true);
  });

  it("accepts only the configured public names when given", async () => {
    const { url } = await setup({ publicHosts: ["GW.example", "::1"] });
    const card = `${url}.well-known/agent-card.json`;
    expect((await rawRequest(card, { headers: { ...auth, host: "gw.example:443" } })).status).toBe(200);
    expect((await rawRequest(card, { headers: { ...auth, host: "[::1]" } })).status).toBe(200);
    expect((await rawRequest(card, { headers: auth })).status).toBe(421);
  });
});

describe("HTTP surface", () => {
  it("refuses requests without the right token", async () => {
    const { rpc } = await setup();
    expect((await rpc("GetTask", { id: "x" }, { auth: null })).status).toBe(401);
    expect((await rpc("GetTask", { id: "x" }, { auth: "Bearer wrong-token-0123456789" })).status).toBe(401);
    expect((await rpc("GetTask", { id: "x" }, { auth: `bearer ${TOKEN}` })).status).toBe(200);
  });

  it("serves JSON-RPC only as a POST to / with a JSON body", async () => {
    const { url } = await setup();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await fetch(`${url}tasks`, { method: "POST", headers: auth })).status).toBe(404);
    expect((await fetch(url, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await fetch(url, { method: "POST", headers: auth, body: new Uint8Array([1]) })).status).toBe(415);
    const a2aJson = await fetch(url, {
      method: "POST",
      headers: { ...auth, "content-type": "application/a2a+json; charset=utf-8", "a2a-version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "GetTask", params: { id: "x" } }),
    });
    expect(((await a2aJson.json()) as Rpc["body"]).error?.code).toBe(-32001);
  });

  it("refuses a body over 1 MiB", async () => {
    const { url } = await setup();
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "x".repeat(MAX_REQUEST_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  it("survives a client that hangs up mid-body", async () => {
    const { port, rpc } = await setup();
    await new Promise<void>((resolve) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(
          `POST / HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"js`,
          () => setTimeout(() => (sock.destroy(), resolve()), 20),
        );
      });
    });
    expect((await rpc("GetTask", { id: "x" })).body.error?.code).toBe(-32001);
  });
});

describe("JSON-RPC envelope and version", () => {
  it("needs A2A-Version 1.0, by header or query parameter", async () => {
    const { rpc } = await setup();
    const none = await rpc("GetTask", { id: "x" }, { version: null, id: "a" });
    expect(none.body).toEqual({
      jsonrpc: "2.0",
      id: "a",
      error: { code: -32009, message: "A2A-Version (empty, meaning 0.3) is not supported; use 1.0" },
    });
    expect((await rpc("GetTask", { id: "x" }, { version: "0.3" })).body.error).toEqual({
      code: -32009,
      message: "A2A-Version 0.3 is not supported; use 1.0",
    });
    const q = await rpc("GetTask", { id: "x" }, { version: null, query: "?A2A-Version=1.0" });
    expect(q.body.error?.code).toBe(-32001);
  });

  it("maps malformed requests to the JSON-RPC codes", async () => {
    const { url, rpc } = await setup();
    const post = async (body: string) =>
      (await (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "a2a-version": "1.0" },
          body,
        })
      ).json()) as Rpc["body"];
    expect(await post("{nope")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload" } });
    expect((await post(JSON.stringify({ id: 1, method: "GetTask" }))).error?.code).toBe(-32600);
    expect((await post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "GetTask" }]))).error?.code).toBe(-32600);
    expect((await rpc("Nope")).body.error).toEqual({ code: -32601, message: "Method not found" });
    // Protocol 0.3 method names are not protocol 1.0 methods.
    expect((await rpc("message/send", { message: message("hi") })).body.error?.code).toBe(-32601);
  });

  it("refuses the optional capabilities the card does not declare", async () => {
    const { rpc } = await setup();
    for (const m of ["SendStreamingMessage", "SubscribeToTask", "GetExtendedAgentCard"]) {
      expect((await rpc(m, {})).body.error?.code).toBe(-32004);
    }
    for (const m of [
      "CreateTaskPushNotificationConfig",
      "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
      "DeleteTaskPushNotificationConfig",
    ]) {
      expect((await rpc(m, {})).body.error?.code).toBe(-32003);
    }
  });

  it("names the bad field in an invalid-params error", async () => {
    const { rpc } = await setup();
    expect((await rpc("GetTask", { id: 5 })).body.error).toEqual({
      code: -32602,
      message: "Invalid parameters: id: Invalid input: expected string, received number",
    });
    expect((await rpc("GetTask")).body.error?.message).toMatch(/^Invalid parameters: Invalid input/);
  });
});

describe("SendMessage to a mesh peer", () => {
  it("sends a task and stays working until the result, then completes with an artifact", async () => {
    const { rpc, mesh, submit, logs } = await setup();
    const t = await submit("review this diff\nplease");
    expect(t.status.state).toBe("TASK_STATE_WORKING");
    expect(t.contextId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.history).toHaveLength(1);
    expect(t.history![0]).toMatchObject({ taskId: t.id, contextId: t.contextId, role: "ROLE_USER" });
    expect(mesh.sent).toEqual([
      { id: expect.any(String), to: "reviewer@laptop", text: "review this diff\nplease", deadline: expect.any(Number) },
    ]);
    expect(logs.some((l) => l.includes(`task ${t.id} sent to reviewer@laptop`))).toBe(true);
    expect(logs.join("\n")).not.toContain("review this diff");

    const working = await rpc("GetTask", { id: t.id });
    expect(working.body.result.status.state).toBe("TASK_STATE_WORKING");

    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "Looks good.", from: "reviewer@laptop" });
    const done = TaskSchema.parse((await rpc("GetTask", { id: t.id })).body.result);
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(done.status.message).toBeUndefined();
    expect(done.artifacts).toEqual([
      { artifactId: expect.any(String), name: "result", parts: [{ text: "Looks good.", mediaType: "text/plain" }] },
    ]);
    expect(Date.parse(done.status.timestamp!)).not.toBeNaN();
  });

  it("trims history to historyLength, and omits it at 0", async () => {
    const { rpc, submit } = await setup();
    const t = await submit("hi", "reviewer@laptop", { configuration: { returnImmediately: true, historyLength: 0 } });
    expect(t.history).toBeUndefined();
    expect((await rpc("GetTask", { id: t.id, historyLength: 1 })).body.result.history).toHaveLength(1);
    expect((await rpc("GetTask", { id: t.id, historyLength: 0 })).body.result.history).toBeUndefined();
  });

  it("blocks by default until the task ends", async () => {
    const { rpc, mesh } = await setup();
    const pending = rpc("SendMessage", { message: message("do it", { worldinmotion: { to: "helper@laptop" } }) });
    const sent = await until(() => mesh.sent[0]);
    mesh.result({ reply_to: sent.id, status: "declined", text: "Not my job.", from: "helper@laptop" });
    const t = TaskSchema.parse((await pending).body.result.task);
    expect(t.status.state).toBe("TASK_STATE_REJECTED");
    expect(t.status.message).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: "Not my job." }], taskId: t.id });
    expect(t.artifacts).toBeUndefined();
  });

  it("maps failed and timeout results to the failed state", async () => {
    const { rpc, mesh, submit } = await setup();
    const a = await submit("a");
    const b = await submit("b");
    const c = await submit("c");
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "failed", text: "Tests broke.", from: "reviewer@laptop" });
    mesh.result({ reply_to: mesh.sent[1]!.id, status: "timeout", text: "Ran out of time.", from: "reviewer@laptop" });
    mesh.result({ reply_to: mesh.sent[2]!.id, status: "timeout", text: "", from: "reviewer@laptop" });
    const state = async (id: string) => (await rpc("GetTask", { id })).body.result.status;
    expect(await state(a.id)).toMatchObject({ state: "TASK_STATE_FAILED", message: { parts: [{ text: "Tests broke." }] } });
    expect(await state(b.id)).toMatchObject({ state: "TASK_STATE_FAILED", message: { parts: [{ text: "Ran out of time." }] } });
    expect(await state(c.id)).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "reviewer@laptop timed out." }] },
    });
  });

  it("fails a task whose peer never answers before the deadline", async () => {
    const { rpc, mesh } = await setup({ taskTimeoutMs: 40 });
    const r = await rpc("SendMessage", { message: message("hello?", { worldinmotion: { to: "reviewer@laptop" } }) });
    expect(r.body.result.task.status).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "No result from reviewer@laptop before the deadline." }] },
    });
    // A late result changes nothing.
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "late", from: "reviewer@laptop" });
    expect((await rpc("GetTask", { id: r.body.result.task.id })).body.result.status.state).toBe("TASK_STATE_FAILED");
  });

  it("ignores a result from anyone but the peer the task went to", async () => {
    const { rpc, mesh, submit, logs } = await setup();
    const t = await submit("secret plan");
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "forged", from: "helper@laptop" });
    expect((await rpc("GetTask", { id: t.id })).body.result.status.state).toBe("TASK_STATE_WORKING");
    expect(logs).toContain(`a2a: result for task ${t.id} from helper@laptop, not reviewer@laptop: ignored`);
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "real", from: "reviewer@laptop" });
    expect((await rpc("GetTask", { id: t.id })).body.result.artifacts[0].parts[0].text).toBe("real");
  });

  it("keeps a result that overtakes its sendTask promise, and drops strays", async () => {
    const { rpc, mesh, submit } = await setup();
    mesh.result({ reply_to: "01STRAY0000000000000000000", status: "done", text: "?", from: "reviewer@laptop" });
    mesh.beforeSendResolves = (id) => {
      // Strays that arrive while a send is in flight are buffered too, oldest dropped first.
      for (let i = 0; i < 70; i++) {
        mesh.result({ reply_to: `stray-${i}`, status: "done", text: "?", from: "reviewer@laptop" });
      }
      mesh.result({ reply_to: id, status: "done", text: "fast", from: "reviewer@laptop" });
    };
    const t = await submit("quick one");
    expect(t.status.state).toBe("TASK_STATE_COMPLETED");
    expect((await rpc("GetTask", { id: t.id })).body.result.artifacts[0].parts[0].text).toBe("fast");
  });

  it("matches results to tasks while several sends are in flight", async () => {
    const { mesh, rpc } = await setup();
    let release!: () => void;
    mesh.holdSends = new Promise((r) => (release = r));
    const send = (text: string) =>
      rpc("SendMessage", {
        message: message(text, { worldinmotion: { to: "reviewer@laptop" } }),
        configuration: { returnImmediately: true },
      });
    const one = send("one");
    const two = send("two");
    await until(() => (mesh.attempts === 2 ? true : undefined));
    // Both results overtake their sends.
    mesh.result({ reply_to: "01WIMTASK00000000000000001", status: "done", text: "first", from: "reviewer@laptop" });
    mesh.result({ reply_to: "01WIMTASK00000000000000002", status: "failed", text: "second", from: "reviewer@laptop" });
    release();
    expect((await one).body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect((await two).body.result.task.status.state).toBe("TASK_STATE_FAILED");
  });

  it("fails the task when the mesh will not take it", async () => {
    const { mesh, submit, logs } = await setup();
    mesh.sendTaskError = new Error("not connected");
    const t = await submit("hi");
    expect(t.status).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "The task could not be delivered to the mesh." }] },
    });
    expect(logs).toContain(`a2a: task ${t.id} to reviewer@laptop not delivered: not connected`);
  });

  it("keeps the task working when a blocking client hangs up", async () => {
    const { mesh, port, rpc } = await setup();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message: message("long job", { worldinmotion: { to: "reviewer@laptop" } }) },
    });
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "a2a-version": "1.0" },
    });
    req.on("error", () => {});
    req.end(body);
    const sent = await until(() => mesh.sent[0]);
    req.destroy();
    await new Promise((r) => setTimeout(r, 20));
    const list = await rpc("ListTasks", {});
    expect(list.body.result.tasks[0].status.state).toBe("TASK_STATE_WORKING");
    mesh.result({ reply_to: sent.id, status: "done", text: "ok", from: "reviewer@laptop" });
    expect((await rpc("ListTasks", {})).body.result.tasks[0].status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("keeps a client-provided contextId", async () => {
    const { rpc } = await setup();
    const r = await rpc("SendMessage", {
      message: { ...message("x", { worldinmotion: { to: "reviewer@laptop" } }), contextId: "ctx-1" },
      configuration: { returnImmediately: true },
    });
    expect(r.body.result.task.contextId).toBe("ctx-1");
  });
});

describe("choosing the peer", () => {
  it("takes the skill id, request metadata, or the configured default", async () => {
    const { mesh, rpc } = await setup({ defaultTo: "helper@laptop" });
    const cfg = { returnImmediately: true };
    await rpc("SendMessage", { message: message("1", { worldinmotion: { skill: "reviewer@laptop" } }), configuration: cfg });
    await rpc("SendMessage", { message: message("2"), metadata: { worldinmotion: { to: "reviewer@laptop" } }, configuration: cfg });
    await rpc("SendMessage", { message: message("3"), configuration: cfg });
    expect(mesh.sent.map((s) => s.to)).toEqual(["reviewer@laptop", "reviewer@laptop", "helper@laptop"]);
  });

  it("refuses a message that names no peer, a bad one, or an unreachable one", async () => {
    const { rpc } = await setup();
    const err = async (meta?: Record<string, unknown>) => (await rpc("SendMessage", { message: message("x", meta) })).body.error;
    expect(await err()).toEqual({
      code: -32602,
      message:
        "Name a peer: metadata.worldinmotion.to (an address) or metadata.worldinmotion.skill (a skill id from the agent card)",
    });
    expect(await err({ worldinmotion: "reviewer@laptop" })).toEqual({
      code: -32602,
      message: "metadata.worldinmotion must be an object of strings",
    });
    for (const to of ["nobody@laptop", "gone@laptop", "outside@laptop"]) {
      expect(await err({ worldinmotion: { to } })).toEqual({ code: -32602, message: `No reachable peer ${to}` });
    }
  });

  it("answers an internal error when the mesh cannot list peers", async () => {
    const { rpc, mesh, logs } = await setup();
    mesh.peersError = new Error("relay down");
    expect((await rpc("SendMessage", { message: message("x", { worldinmotion: { to: "reviewer@laptop" } }) })).body.error).toEqual({
      code: -32603,
      message: "Internal error",
    });
    expect(logs).toContain("a2a: SendMessage failed: relay down");
  });
});

describe("refused messages", () => {
  const to = { worldinmotion: { to: "reviewer@laptop" } };

  it("refuses non-text parts and non-text output modes with ContentTypeNotSupported", async () => {
    const { rpc } = await setup();
    const send = async (msg: unknown, configuration?: unknown) => (await rpc("SendMessage", { message: msg, configuration })).body;
    const base = message("x", to);
    for (const part of [{ url: "https://x/f.png", mediaType: "image/png" }, { data: { a: 1 } }, { raw: "AAAA" }]) {
      expect((await send({ ...base, parts: [{ text: "see" }, part] })).error).toEqual({
        code: -32005,
        message: "Only text parts are supported",
      });
    }
    expect((await send({ ...base, parts: [{ text: "{}", mediaType: "application/json" }] })).error?.code).toBe(-32005);
    expect((await send(base, { acceptedOutputModes: ["image/png"] })).error).toEqual({
      code: -32005,
      message: "This agent only answers in text/plain",
    });
    const ok = await send({ ...base, parts: [{ text: "# hi", mediaType: "text/markdown" }] }, {
      acceptedOutputModes: ["image/png", "text/plain"],
      returnImmediately: true,
    });
    expect(ok.result.task.status.state).toBe("TASK_STATE_WORKING");
  });

  it("refuses an agent-role, empty or oversized message", async () => {
    const { rpc } = await setup();
    const send = async (msg: unknown) => (await rpc("SendMessage", { message: msg })).body.error;
    expect(await send({ ...message("x", to), role: "ROLE_AGENT" })).toEqual({
      code: -32602,
      message: "message.role must be ROLE_USER",
    });
    expect(await send(message("  \n", to))).toEqual({ code: -32602, message: "message text is empty" });
    expect(await send(message("x".repeat(MAX_TASK_TEXT_BYTES + 1), to))).toEqual({
      code: -32602,
      message: `message text is larger than ${MAX_TASK_TEXT_BYTES} bytes`,
    });
    expect((await send({ ...message("x", to), parts: [] }))?.code).toBe(-32602);
  });

  it("refuses push notification config and follow-ups to a task", async () => {
    const { rpc, submit } = await setup();
    expect(
      (await rpc("SendMessage", { message: message("x", to), configuration: { taskPushNotificationConfig: { url: "https://x" } } })).body
        .error?.code,
    ).toBe(-32003);
    expect((await rpc("SendMessage", { message: { ...message("x", to), taskId: "nope" } })).body.error).toEqual({
      code: -32001,
      message: "Task not found",
    });
    const t = await submit("first");
    expect((await rpc("SendMessage", { message: { ...message("more", to), taskId: t.id } })).body.error).toEqual({
      code: -32004,
      message: "Follow-up messages to a task are not supported; send a new message",
    });
  });
});

describe("task store", () => {
  it("refuses new tasks when full of running ones, and evicts finished ones", async () => {
    const { rpc, mesh, submit } = await setup({ maxTasks: 1 });
    const first = await submit("one");
    const full = await rpc("SendMessage", {
      message: message("two", { worldinmotion: { to: "reviewer@laptop" } }),
      configuration: { returnImmediately: true },
    });
    expect(full.body.error).toEqual({ code: -32603, message: "Too many tasks in progress" });
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "ok", from: "reviewer@laptop" });
    await submit("three");
    expect((await rpc("GetTask", { id: first.id })).body.error?.code).toBe(-32001);
  });

  it("forgets tasks after their time to live", async () => {
    const c = clock();
    const { rpc, mesh, submit } = await setup({ now: c.now, taskTtlMs: 10_000 });
    const t = await submit("x");
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "ok", from: "reviewer@laptop" });
    c.advance(9_999);
    expect((await rpc("GetTask", { id: t.id })).body.result.id).toBe(t.id);
    c.advance(1);
    expect((await rpc("GetTask", { id: t.id })).body.error?.code).toBe(-32001);
    // A result for a task that has been forgotten is dropped.
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "again", from: "reviewer@laptop" });
  });

  it("drops a result for a running task the store has already forgotten", async () => {
    const c = clock();
    const { rpc, mesh, submit } = await setup({ now: c.now, taskTtlMs: 10_000 });
    const t = await submit("x");
    c.advance(10_000);
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "ok", from: "reviewer@laptop" });
    expect((await rpc("GetTask", { id: t.id })).body.error?.code).toBe(-32001);
  });
});

describe("CancelTask", () => {
  it("cancels a working task once, and drops its later result", async () => {
    const { rpc, mesh, submit } = await setup();
    const t = await submit("x");
    const c = await rpc("CancelTask", { id: t.id });
    expect(c.body.result.status).toMatchObject({
      state: "TASK_STATE_CANCELED",
      message: { parts: [{ text: "Canceled by the client." }] },
    });
    expect((await rpc("CancelTask", { id: t.id })).body.error).toEqual({ code: -32002, message: "Task is already finished" });
    expect((await rpc("CancelTask", { id: "nope" })).body.error?.code).toBe(-32001);
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "late", from: "reviewer@laptop" });
    expect((await rpc("GetTask", { id: t.id })).body.result.status.state).toBe("TASK_STATE_CANCELED");
  });
});

describe("ListTasks", () => {
  it("lists newest first with filters and cursor pages", async () => {
    const c = clock();
    const { rpc, mesh, submit } = await setup({ now: c.now });
    const a = await submit("a", "reviewer@laptop", { message: { ...message("a", { worldinmotion: { to: "reviewer@laptop" } }), contextId: "ctx" } });
    c.advance(1000);
    const b = await submit("b");
    const d = await submit("d");
    c.advance(1000);
    mesh.result({ reply_to: mesh.sent[0]!.id, status: "done", text: "A", from: "reviewer@laptop" });

    const all = (await rpc("ListTasks", {})).body.result;
    const tied = [b.id, d.id].sort().reverse();
    expect(all.tasks.map((t: Task) => t.id)).toEqual([a.id, ...tied]);
    expect(all).toMatchObject({ nextPageToken: "", pageSize: 50, totalSize: 3 });
    expect(all.tasks[0].artifacts).toBeUndefined();

    const withArtifacts = (await rpc("ListTasks", { includeArtifacts: true, historyLength: 0 })).body.result;
    expect(withArtifacts.tasks[0].artifacts[0].parts[0].text).toBe("A");
    expect(withArtifacts.tasks[0].history).toBeUndefined();

    expect((await rpc("ListTasks", { contextId: "ctx" })).body.result.tasks.map((t: Task) => t.id)).toEqual([a.id]);
    expect((await rpc("ListTasks", { status: "TASK_STATE_WORKING" })).body.result.totalSize).toBe(2);
    const after = new Date(c.now() - 500).toISOString();
    expect((await rpc("ListTasks", { statusTimestampAfter: after })).body.result.tasks.map((t: Task) => t.id)).toEqual([a.id]);

    const seen: string[] = [];
    let token = "";
    for (let i = 0; i < 3; i++) {
      const page = (await rpc("ListTasks", { pageSize: 1, ...(token === "" ? {} : { pageToken: token }) })).body.result;
      seen.push(...page.tasks.map((t: Task) => t.id));
      token = page.nextPageToken;
    }
    expect(seen).toEqual([a.id, ...tied]);
    expect(token).toBe("");
    expect((await rpc("ListTasks", { pageToken: "" })).body.result.totalSize).toBe(3);
  });

  it("refuses bad page tokens and sizes, and an old cursor yields nothing", async () => {
    const { rpc, submit } = await setup();
    await submit("a");
    expect((await rpc("ListTasks", { pageToken: "garbage" })).body.error).toEqual({
      code: -32602,
      message: "Invalid parameters: pageToken is not a token this server issued",
    });
    expect((await rpc("ListTasks", { pageSize: 101 })).body.error?.code).toBe(-32602);
    expect((await rpc("ListTasks", { status: "TASK_STATE_RUNNING" })).body.error?.code).toBe(-32602);
    const old = Buffer.from(JSON.stringify([0, ""])).toString("base64url");
    expect((await rpc("ListTasks", { pageToken: old })).body.result).toMatchObject({ tasks: [], totalSize: 1, nextPageToken: "" });
  });
});

describe("defaults", () => {
  it("logs to stderr and uses the real clock when not given either", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    onTestFinished(() => write.mockRestore());
    const mesh = new FakeMesh();
    const gw = new InboundGateway({ mesh, token: TOKEN });
    const { url } = await gw.start();
    onTestFinished(() => gw.close());
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "a2a-version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { message: message("x", { worldinmotion: { to: "reviewer@laptop" } }), configuration: { returnImmediately: true } },
      }),
    });
    const t = ((await res.json()) as Rpc["body"]).result.task as Task;
    expect(Math.abs(Date.parse(t.status.timestamp!) - Date.now())).toBeLessThan(5000);
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`a2a: task ${t.id} sent to reviewer@laptop`));
  });
});
