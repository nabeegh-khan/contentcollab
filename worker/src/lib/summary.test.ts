// Summaries and suggested tags (#26, ARCHITECTURE D22): the reply check, the stub provider, the
// Anthropic provider against a stand-in client (no network), and the provider chosen from the env.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkReply,
  stubProvider,
  anthropicProvider,
  providerFromEnv,
  MAX_SUMMARY_CHARS,
  MAX_TAGS,
  DEFAULT_MODEL,
  type MessagesClient,
} from "./summary.js";

const failsWith = (text: string) => (err: unknown) =>
  err instanceof Error && err.message.includes(text);

test("a reply with a short summary and a few lower-case tags passes", () => {
  const reply = { summary: "Two reviewers agree the limit is 50 MB.", tags: ["upload", "limits"] };
  assert.deepEqual(checkReply(reply), reply);
});

test("replies outside the shape are refused", () => {
  assert.throws(() => checkReply({ summary: "", tags: [] }), failsWith("summary"));
  assert.throws(
    () => checkReply({ summary: "x".repeat(MAX_SUMMARY_CHARS + 1), tags: [] }),
    failsWith("summary"),
  );
  const tooMany = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`);
  assert.throws(() => checkReply({ summary: "ok", tags: tooMany }), failsWith("tags"));
  assert.throws(() => checkReply({ summary: "ok", tags: ["Upper Case"] }), failsWith("tags"));
  assert.throws(() => checkReply({ summary: "ok" }), failsWith("tags"));
  assert.throws(() => checkReply("just text"), failsWith("summary"));
});

test("the stub provider's reply passes the check", async () => {
  checkReply(await stubProvider.summarize("thread", "any text"));
});

// A stand-in for the SDK client: records the request and returns a canned message
function clientReturning(message: object): MessagesClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    messages: {
      create: async (params: unknown) => {
        requests.push(params);
        return message as never;
      },
    },
  };
}

const replyText = JSON.stringify({ summary: "Revert makes a new version.", tags: ["versions"] });

test("the Anthropic provider asks for the JSON shape and returns the parsed reply", async () => {
  const client = clientReturning({
    stop_reason: "end_turn",
    content: [{ type: "text", text: replyText }],
  });
  const reply = await anthropicProvider(client, DEFAULT_MODEL).summarize("version", "- a\n+ b");
  assert.deepEqual(reply, JSON.parse(replyText));
  const params = client.requests[0] as {
    model: string;
    output_config: { format: { type: string; schema: { required: string[] } } };
    messages: Array<{ content: string }>;
  };
  assert.equal(params.model, DEFAULT_MODEL);
  assert.equal(params.output_config.format.type, "json_schema");
  assert.deepEqual(params.output_config.format.schema.required.sort(), ["summary", "tags"]);
  assert.ok(params.messages[0]?.content.includes("- a\n+ b"));
});

test("a refusal or a cut-off reply fails instead of returning nothing", async () => {
  const refused = clientReturning({ stop_reason: "refusal", content: [] });
  await assert.rejects(
    anthropicProvider(refused, DEFAULT_MODEL).summarize("thread", "t"),
    failsWith("refusal"),
  );
  const cut = clientReturning({
    stop_reason: "max_tokens",
    content: [{ type: "text", text: "{" }],
  });
  await assert.rejects(
    anthropicProvider(cut, DEFAULT_MODEL).summarize("thread", "t"),
    failsWith("max_tokens"),
  );
});

test("the provider comes from SUMMARY_PROVIDER: the stub unless asked for the model", () => {
  assert.equal(providerFromEnv({}), stubProvider);
  assert.equal(providerFromEnv({ SUMMARY_PROVIDER: "stub" }), stubProvider);
  assert.notEqual(providerFromEnv({ SUMMARY_PROVIDER: "anthropic" }), stubProvider);
  assert.throws(
    () => providerFromEnv({ SUMMARY_PROVIDER: "other" }),
    failsWith("SUMMARY_PROVIDER"),
  );
});
