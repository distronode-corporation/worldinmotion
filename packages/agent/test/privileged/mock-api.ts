// A stand-in for the Anthropic API on 127.0.0.1, for driving the real Agent SDK in tests: the
// Messages API (streaming and not) answering from a script, and the token endpoint answering
// Workload Identity Federation exchanges. No request leaves the machine.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export type Step = { tool: string; input: Record<string, unknown> } | { text: string };

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockApi {
  url: string;
  seen: Seen[];
  /** Every tool_result the SDK sent back, as text. */
  toolResults(): string[];
  close(): Promise<void>;
}

export const ACCESS_TOKEN = "mock-access-token-0123456789";

export async function startMockApi(script: (turn: number) => Step): Promise<MockApi> {
  const seen: Seen[] = [];
  let turn = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === "/v1/oauth/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      if (!req.url!.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const parsed = JSON.parse(body) as { model: string; stream?: boolean };
      const step = script(turn++);
      const content = "tool" in step ? [{ type: "tool_use", id: `toolu_${turn}`, name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
      const stop = "tool" in step ? "tool_use" : "end_turn";
      const msg = { id: `msg_${turn}`, type: "message", role: "assistant", model: parsed.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
      if (parsed.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t: string, d: Record<string, unknown>) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null } });
      content.forEach((c, i) => {
        if (c.type === "text") {
          ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index: i, delta: { type: "text_delta", text: (c as { text: string }).text } });
        } else {
          const t = c as { id: string; name: string; input: unknown };
          ev("content_block_start", { index: i, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } });
          ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } });
        }
        ev("content_block_stop", { index: i });
      });
      ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    toolResults: () =>
      seen
        .filter((s) => s.url.startsWith("/v1/messages"))
        .flatMap((s) => (JSON.parse(s.body) as { messages: Array<{ content: unknown }> }).messages)
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((c: { type?: string }) => c.type === "tool_result")
        .map((c) => JSON.stringify(c)),
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
