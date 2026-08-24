// Wire translators: convert the client's chat-completions body into each
// upstream API shape, and translate responses back to chat format.
import type { CatalogEntry } from "./catalog";

// ---- OpenAI Responses API (codex) -------------------------------------------

export function chatToResponses(body: Record<string, any>, upstreamModel: string): Record<string, any> {
  const instructions: string[] = [];
  const input: any[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      instructions.push(typeof m.content === "string" ? m.content : flatten(m.content));
    } else if (m.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: flatten(m.content) }] });
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : flatten(m.content);
      const item: any = { role: "assistant", content: [{ type: "output_text", text }] };
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments ?? "{}",
          });
        }
      }
      if (text) input.push(item);
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    }
  }
  const out: Record<string, any> = {
    model: upstreamModel,
    instructions: instructions.join("\n\n"),
    input,
    stream: true, // codex endpoint requires streaming
    store: false,
  };
  // reasoning effort mapping
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort !== "none")
    out.reasoning = { effort: body.reasoning_effort };
  if (body.tools && Array.isArray(body.tools)) out.tools = body.tools.map(mapTool);
  if (body.max_tokens) out.max_output_tokens = body.max_tokens;
  return out;
}

function mapTool(t: any): any {
  if (t.type === "function" && t.function) {
    return { type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters };
  }
  return t;
}

/** Parse a Responses SSE stream into chat-style usage + text deltas. Returns tap fn. */
export function responsesUsageOf(event: any): { prompt?: number; completion?: number } | null {
  if (event?.type === "response.completed" && event.response?.usage) {
    const u = event.response.usage;
    return { prompt: u.input_tokens, completion: u.output_tokens };
  }
  return null;
}

export function sseDataToChatChunk(respEvent: any): any | null {
  // map response.output_text.delta -> chunk
  if (respEvent?.type === "output_text_delta" || respEvent?.type === "response.output_text.delta")
    return respEvent.delta ?? respEvent.text ?? "";
  return null;
}

function flatten(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  return String(content ?? "");
}
