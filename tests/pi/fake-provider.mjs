// A scripted OpenAI-compatible chat completions endpoint for real-pi tests. Each
// request's decision comes from `decide(messages)`, which returns { text } or
// { tool: { name, args } }. It records every request body.
import { createServer } from "node:http";

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

export async function startFakeProvider(decide) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      requests.push(request);
      const answer = decide(request.messages ?? []);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (answer.tool) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: answer.text }));
        res.write(chunk({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p.text ?? "").join("\n"));

// The relay probe: a parent that starts one agent and reports its result, and a
// child that runs one bash command and reports its result. The last user message
// says which of the two a request belongs to; a tool message after it means the
// tool already ran.
export function relayScript(marker) {
  return (messages) => {
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const prompt = textOf(messages[lastUser]?.content);
    const toolResult = messages.slice(lastUser + 1).find((m) => m.role === "tool");
    if (prompt.includes("PARENT-TASK")) {
      return toolResult
        ? { text: `PARENT-DONE ${textOf(toolResult.content)}` }
        : { tool: { name: "agent", args: { description: "relay probe", prompt: "CHILD-TASK run the probe" } } };
    }
    return toolResult
      ? { text: `CHILD-DONE ${textOf(toolResult.content)}` }
      : { tool: { name: "bash", args: { command: `echo probed > ${marker}` } } };
  };
}
