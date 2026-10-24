import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("fills defaults for an inbound-only config", () => {
    const c = loadConfig({ inbound: { tokenEnv: "WIM_A2A_TOKEN" } });
    expect(c.inbound).toEqual({
      host: "127.0.0.1",
      port: 41_241,
      allowNonLoopback: false,
      tokenEnv: "WIM_A2A_TOKEN",
      taskTimeoutSeconds: 300,
      maxTasks: 1000,
      taskTtlSeconds: 3600,
      cardRequiresAuth: true,
    });
    expect(c.outbound).toBeUndefined();
  });

  it("fills defaults for an outbound-only config", () => {
    const c = loadConfig({
      outbound: { agents: [{ name: "weather", cardUrl: "https://agent.example/.well-known/agent-card.json", authHeaderEnv: "WEATHER_AUTH" }] },
    });
    expect(c.outbound).toMatchObject({ requestTimeoutSeconds: 15, defaultDeadlineSeconds: 300, maxDeadlineSeconds: 3600, maxConcurrent: 4 });
  });

  it("allows a non-loopback bind only when asked, and only with TLS", () => {
    const tls = { certPath: "/etc/wim/cert.pem", keyPath: "/etc/wim/key.pem" };
    const c = loadConfig({
      inbound: { tokenEnv: "T", host: "0.0.0.0", allowNonLoopback: true, tls, publicHosts: ["gw.example", "::1"] },
    });
    expect(c.inbound).toMatchObject({ host: "0.0.0.0", tls, publicHosts: ["gw.example", "::1"] });
    expect(() => loadConfig({ inbound: { tokenEnv: "T", host: "0.0.0.0", tls } })).toThrow(
      "inbound.host: binding beyond loopback needs allowNonLoopback: true",
    );
    expect(() => loadConfig({ inbound: { tokenEnv: "T", host: "0.0.0.0", allowNonLoopback: true } })).toThrow(
      "inbound.tls: binding beyond loopback needs tls",
    );
    expect(loadConfig({ inbound: { tokenEnv: "T", tls } }).inbound?.tls).toEqual(tls);
  });

  it("checks publicHosts and that publicUrl is one of them", () => {
    expect(loadConfig({ inbound: { tokenEnv: "T", publicUrl: "http://localhost:8080/" } }).inbound?.publicUrl).toBe(
      "http://localhost:8080/",
    );
    expect(
      loadConfig({ inbound: { tokenEnv: "T", publicHosts: ["GW.example"], publicUrl: "https://gw.example/a2a" } }).inbound
        ?.publicHosts,
    ).toEqual(["GW.example"]);
    expect(() => loadConfig({ inbound: { tokenEnv: "T", publicUrl: "https://gw.example/" } })).toThrow(
      "inbound.publicUrl: its host must be one of publicHosts, or requests to it are refused",
    );
    expect(() => loadConfig({ inbound: { tokenEnv: "T", publicHosts: ["gw.example/x"] } })).toThrow(
      "inbound.publicHosts.0: must be a host name or IP address",
    );
    expect(() => loadConfig({ inbound: { tokenEnv: "T", publicHosts: [] } })).toThrow("inbound.publicHosts");
  });

  it("reports every problem on its own line", () => {
    let message = "";
    try {
      loadConfig({
        inbound: { tokenEnv: "1bad", taskTimeoutSeconds: 60, taskTtlSeconds: 60 },
        outbound: { agents: [{ name: "Bad Name", cardUrl: "http://agent.example/card" }] },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.split("\n")).toEqual([
      "invalid a2a config:",
      "inbound.tokenEnv: must be an environment variable name",
      "inbound.taskTtlSeconds: must be longer than taskTimeoutSeconds",
      "outbound.agents.0.name: must be a session name ([a-z0-9-], 1 to 32)",
      "outbound.agents.0.cardUrl: URL must be https, or http to a loopback host",
    ]);
  });

  it("needs at least one half, and refuses unknown keys", () => {
    expect(() => loadConfig({})).toThrow("config: configure inbound, outbound, or both");
    expect(() => loadConfig({ inbound: { tokenEnv: "T", token: "x" } })).toThrow("inbound");
  });
});
