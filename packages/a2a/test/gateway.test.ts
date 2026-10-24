import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { startGateway } from "../src/gateway.ts";
import { agentCard, FakeMesh, json, rawRequest, selfSignedTls, serve, TOKEN, until } from "./helpers.ts";

describe("startGateway", () => {
  it("runs both directions on one mesh, keeping their credentials apart", async () => {
    let base = "";
    const ext = await serve((req, res) => {
      if (req.method === "GET") return json(res, 200, agentCard(`${base}/rpc`));
      const b = JSON.parse(req.body) as { id: string };
      json(res, 200, { jsonrpc: "2.0", id: b.id, result: { message: { messageId: "r", role: "ROLE_AGENT", parts: [{ text: "pong" }] } } });
    });
    base = ext.base;
    const config = loadConfig({
      inbound: { tokenEnv: "WIM_A2A_TOKEN", port: 0 },
      outbound: { agents: [{ name: "pinger", cardUrl: `${ext.base}/.well-known/agent-card.json`, authHeaderEnv: "PINGER_AUTH" }] },
    });
    const mesh = new FakeMesh();
    const logs: string[] = [];
    const gw = await startGateway(config, mesh, {
      env: { WIM_A2A_TOKEN: TOKEN, PINGER_AUTH: "Bearer pinger-only" },
      log: (l) => logs.push(l),
    });
    onTestFinished(() => gw.close());
    expect(gw.outbound?.sessions()).toEqual([{ name: "pinger", kind: "a2a" }]);

    // Inbound: an A2A client reaches a mesh peer.
    const res = await fetch(gw.url!, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "a2a-version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }], metadata: { worldinmotion: { to: "reviewer@laptop" } } },
          configuration: { returnImmediately: true },
        },
      }),
    });
    expect(((await res.json()) as { result: { task: { status: { state: string } } } }).result.task.status.state).toBe(
      "TASK_STATE_WORKING",
    );
    expect(mesh.sent[0]!.to).toBe("reviewer@laptop");

    // Outbound: a mesh peer reaches the external agent.
    mesh.task({ id: "01PING", to: "pinger@gw", from: "reviewer@laptop", text: "ping" });
    expect(await until(() => mesh.results[0])).toEqual({ to: "reviewer@laptop", taskId: "01PING", status: "done", text: "pong" });
    for (const s of ext.seen) {
      expect(s.headers.authorization).toBe("Bearer pinger-only");
      expect(JSON.stringify(s.headers)).not.toContain(TOKEN);
    }
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain("pinger-only");
  });

  it("reads the TLS files the config names and serves HTTPS", async () => {
    const { certPath, keyPath, cert } = selfSignedTls();
    const gw = await startGateway(
      loadConfig({ inbound: { tokenEnv: "T", port: 0, tls: { certPath, keyPath } } }),
      new FakeMesh(),
      { env: { T: TOKEN } },
    );
    onTestFinished(() => gw.close());
    expect(gw.url).toMatch(/^https:/);
    const r = await rawRequest(`${gw.url!}.well-known/agent-card.json`, { headers: { authorization: `Bearer ${TOKEN}` }, ca: cert });
    expect(r.status).toBe(200);
  });

  it("stops before subscribing when the inbound token is missing", async () => {
    const mesh = new FakeMesh();
    const onTask = vi.spyOn(mesh, "onTask");
    const onResult = vi.spyOn(mesh, "onResult");
    const config = loadConfig({
      inbound: { tokenEnv: "WIM_A2A_TOKEN", port: 0 },
      outbound: { agents: [{ name: "x", cardUrl: "https://agent.example/card" }] },
    });
    await expect(startGateway(config, mesh, { env: {} })).rejects.toThrow("environment variable WIM_A2A_TOKEN is not set");
    expect(onTask).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("starts one half alone, reading process.env by default", async () => {
    vi.stubEnv("WIM_TEST_A2A_TOKEN", TOKEN);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const inbound = await startGateway(loadConfig({ inbound: { tokenEnv: "WIM_TEST_A2A_TOKEN", port: 0 } }), new FakeMesh());
    expect(inbound.outbound).toBeUndefined();
    expect(inbound.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await inbound.close();
    const outbound = await startGateway(
      loadConfig({ outbound: { agents: [{ name: "x", cardUrl: "https://agent.example/card" }] } }),
      new FakeMesh(),
    );
    expect(outbound.inbound).toBeUndefined();
    await outbound.close();
  });
});
