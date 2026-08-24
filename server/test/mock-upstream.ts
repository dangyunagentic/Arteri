// Mock upstream provider for E2E tests — speaks both OpenAI and Anthropic shapes,
// echoes the exact request it received so we can assert thinking clamps.
const seen = [];

function jsonReq(req) {
  return new Response(JSON.stringify({ received: req.got, error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

Bun.serve({
  port: 9991,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/models") {
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-5.2" }, { id: "gpt-5.2-mini" }, { id: "claude-sonnet-thinking" }],
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (req.method === "POST" && ["/chat/completions", "/v1/chat/completions"].includes(url.pathname)) {
      const body = await req.json();
      const auth = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      seen.push(body);
      const stream = !!body.stream;

      if (!stream) {
        if (false) {
          // anthropic non-stream shape
          return new Response(
            JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "anthropic says hi" }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 12,
                output_tokens: 34,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: "cmpl_1",
            object: "chat.completion",
            choices: [
              { index: 0, message: { role: "assistant", content: "openai says hi" }, finish_reason: "stop" },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      // SSE stream
      const isAnthro = false; // mock openai upstream only
      const enc = new TextEncoder();
      let events;
      if (isAnthro) {
        events = [
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 15, output_tokens: 0 } } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 25 } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
      } else {
        events = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 22, completion_tokens_details: { reasoning_tokens: 9 } } })}\n\n`,
          `data: [DONE]\n\n`,
        ];
      }
      const body2 = new ReadableStream({
        start(ctrl) {
          for (const e of events) ctrl.enqueue(enc.encode(e));
          ctrl.close();
        },
      });
      return new Response(body2, {
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (url.pathname === "/_bodies") {
      return new Response(JSON.stringify(seen), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log("mock upstream on :9991");
