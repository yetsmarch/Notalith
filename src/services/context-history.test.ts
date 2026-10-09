import { describe, expect, it } from "vitest";
import {
  ConversationHistory,
  estimateContextTokens,
  estimateTextTokens,
  serializeContext,
} from "./context-history";

const history = () =>
  new ConversationHistory<Record<string, unknown>>((text) => [
    { role: "user", content: text },
    { role: "assistant", content: "Noted." },
  ]);

describe("conversation history projection", () => {
  it("keeps tools with their user interaction and preserves native protocol metadata", () => {
    const context = history();
    context.beginTurn();
    context.append(
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
    );
    context.finishTurn();
    context.beginTurn();
    const call = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", signature: "signed" },
        {
          type: "tool_use",
          id: "call",
          name: "read_note",
          input: { path: "Notes/a.md" },
        },
      ],
    };
    context.append({ role: "user", content: "recent" }, call);
    context.append({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call", content: "note" }],
    });
    const before = context.snapshot();
    expect(before.turns).toHaveLength(2);
    expect(before.turns[1].complete).toBe(false);
    context.replace("old facts", 1, before.revision);
    expect(context.items.slice(2)).toEqual([
      { role: "user", content: "recent" },
      call,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call", content: "note" },
        ],
      },
    ]);
    expect(context.snapshot().turns[0].text).not.toContain("signed");
    context.abortTurn();
    expect(context.snapshot().turns).toEqual([]);
    expect(context.snapshot().summary).toBe("old facts");
    expect(context.items).toHaveLength(2);
  });

  it("replaces rather than stacks summaries and reset clears the summary", () => {
    const context = history();
    for (const content of ["first", "second"]) {
      context.beginTurn();
      context.append({ role: "user", content });
      context.finishTurn();
    }
    context.replace("summary one", 1, context.snapshot().revision);
    context.replace("summary two", 1, context.snapshot().revision);
    expect(context.items).toHaveLength(2);
    expect(JSON.stringify(context.items)).not.toContain("summary one");
    expect(context.snapshot().summary).toBe("summary two");
    context.reset();
    expect(context.snapshot()).toMatchObject({
      summary: "",
      turns: [],
      tokens: estimateContextTokens([]),
    });
  });

  it("rejects stale and unfinished replacements without mutating the history", () => {
    const context = history();
    context.beginTurn();
    context.append({ role: "user", content: "running" });
    const before = context.snapshot();
    expect(() => context.replace("summary", 1, before.revision)).toThrow(
      "unfinished",
    );
    context.finishTurn();
    expect(() => context.replace("summary", 1, before.revision)).toThrow(
      "changed",
    );
    expect(context.items).toEqual([{ role: "user", content: "running" }]);
  });

  it("estimates native replacements exactly with the same estimator", () => {
    const context = history();
    context.beginTurn();
    context.append({ role: "user", content: "old" });
    context.finishTurn();
    const estimate = context.replacementTokens("summary", 1);
    context.replace("summary", 1, context.snapshot().revision);
    expect(context.snapshot().tokens).toBe(estimate);
  });

  it("does not send image data, signatures or private reasoning to the summarizer", () => {
    const input = [
      { type: "image", source: { type: "base64", data: "IMAGE_PIXELS" } },
      { inlineData: { mimeType: "image/png", data: "GEMINI_PIXELS" } },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,CHAT_PIXELS" },
      },
      {
        type: "thinking",
        thinking: "PRIVATE_REASONING",
        signature: "SIGNATURE",
      },
      {
        type: "reasoning",
        summary: [{ text: "REASONING_SUMMARY" }],
        encrypted_content: "ENCRYPTED",
      },
      {
        thought: true,
        text: "GEMINI_THOUGHT",
        thoughtSignature: "THOUGHT_SIGNATURE",
      },
      { type: "text", text: "Saved image: Attachments/a.png" },
    ];
    const text = serializeContext(input);
    for (const secret of [
      "IMAGE_PIXELS",
      "GEMINI_PIXELS",
      "CHAT_PIXELS",
      "PRIVATE_REASONING",
      "SIGNATURE",
      "ENCRYPTED",
      "GEMINI_THOUGHT",
      "REASONING_SUMMARY",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("Attachments/a.png");
    expect(estimateContextTokens(input)).toBeGreaterThan(3 * 4096);
  });

  it("does not apply the ASCII character ratio to Chinese text", () => {
    expect(estimateTextTokens("a".repeat(300))).toBe(100);
    expect(estimateTextTokens("中".repeat(300))).toBe(600);
    expect(estimateTextTokens("hello中文")).toBe(6);
  });
});
