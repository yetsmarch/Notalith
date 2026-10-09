import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../providers/provider";
import type { ProviderInput } from "../types";
import { ConversationHistory } from "./context-history";
import {
  ContextCompactor,
  type ContextActivity,
  DEFAULT_CONTEXT_INPUT_BUDGET,
  normalizeContextInputBudget,
} from "./context-compaction";

const input: ProviderInput = {
  kind: "message",
  message: { text: "Continue", images: [] },
};

function fixture() {
  const context = new ConversationHistory<Record<string, unknown>>((text) => [
    { role: "user", content: text },
    { role: "assistant", content: "Noted." },
  ]);
  const summarizer = {
    context: new ConversationHistory<unknown>(() => []),
    supportsImages: false,
    supportsImageToolResults: false,
    resetConversation: vi.fn(),
    finishTurn: vi.fn(),
    abortTurn: vi.fn(),
    testConnection: vi.fn(),
    createSummaryProvider: vi.fn(),
    respond: vi.fn<ModelProvider["respond"]>(
      async (_input, tools, handlers, _signal, options) => {
        expect(tools).toEqual([]);
        expect(options).toEqual({ maxOutputTokens: 2000 });
        handlers.onTextDelta(
          "Goal: finish the note. Constraint: preserve user content. Pending: insert Attachments/a.png.",
        );
        return {
          toolCalls: [],
          usage: { inputTokens: 25_000, outputTokens: 30 },
        };
      },
    ),
  } satisfies ModelProvider;
  const provider = {
    ...summarizer,
    context,
    createSummaryProvider: vi.fn(() => summarizer),
    onContextReplaced: vi.fn(),
  } satisfies ModelProvider;
  const add = (marker: string, size = 12_000) => {
    context.beginTurn();
    context.append(
      { role: "user", content: marker + "x".repeat(size) },
      { role: "assistant", content: "done" },
    );
    context.finishTurn();
  };
  const fill = () => {
    for (let i = 0; i < 9; i++) add(`old-${i}`);
  };
  return { context, provider, summarizer, add, fill };
}

describe("automatic rolling context compaction", () => {
  it("migrates missing budgets and rejects invalid persisted values", () => {
    expect(normalizeContextInputBudget(undefined)).toBe(
      DEFAULT_CONTEXT_INPUT_BUDGET,
    );
    for (const value of [null, "32000", NaN, Infinity, 7999, 8000.5, 1_000_001])
      expect(() => normalizeContextInputBudget(value)).toThrow("budget");
    expect(normalizeContextInputBudget(8000)).toBe(8000);
    expect(normalizeContextInputBudget(1_000_000)).toBe(1_000_000);
  });

  it("does not call a summarizer below or exactly at the budget", async () => {
    const { provider, context } = fixture();
    const activity = vi.fn<(activity: ContextActivity) => void>();
    const compactor = new ContextCompactor(provider, "system", () => 32_000);
    const estimate = await compactor.prepare(
      input,
      [],
      new AbortController().signal,
      activity,
    );
    expect(provider.createSummaryProvider).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    const snapshot = context.snapshot();
    const atLimit = { ...snapshot, tokens: snapshot.tokens + 8000 - estimate };
    const snapshotSpy = vi.spyOn(context, "snapshot").mockReturnValue(atLimit);
    const limitCompactor = new ContextCompactor(provider, "system", () => 8000);
    await expect(
      limitCompactor.prepare(input, [], new AbortController().signal, activity),
    ).resolves.toBe(8000);
    expect(provider.createSummaryProvider).not.toHaveBeenCalled();
    snapshotSpy.mockReturnValue({ ...atLimit, tokens: atLimit.tokens + 1 });
    await expect(
      limitCompactor.prepare(input, [], new AbortController().signal, activity),
    ).rejects.toThrow("No completed");
  });

  it("reduces projected input by more than 50%, preserves recent turns and reports summary usage", async () => {
    const { context, provider, summarizer, fill } = fixture();
    fill();
    const recent = context.items.slice(-2);
    const activity = vi.fn<(activity: ContextActivity) => void>();
    const before = context.snapshot().tokens;
    const after = await new ContextCompactor(
      provider,
      "system",
      () => 32_000,
    ).prepare(input, [], new AbortController().signal, activity);
    expect(after).toBeLessThan(before * 0.5);
    expect(context.items.slice(-2)).toEqual(recent);
    expect(context.snapshot().summary).toContain("Attachments/a.png");
    expect(provider.onContextReplaced).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls.map(([value]) => value.status)).toEqual([
      "running",
      "complete",
    ]);
    expect(activity.mock.calls[1][0]).toMatchObject({
      usage: { inputTokens: 25_000, outputTokens: 30 },
    });
    const request = vi.mocked(summarizer.respond).mock.calls[0][0];
    expect(request.kind).toBe("message");
    if (request.kind === "message") {
      expect(request.message.text).toContain("old-0");
      expect(request.message.text).not.toContain("old-8");
    }
    await new ContextCompactor(provider, "system", () => 32_000).prepare(
      input,
      [],
      new AbortController().signal,
      activity,
    );
    expect(summarizer.respond).toHaveBeenCalledTimes(1);
  });

  it("updates the old summary only with newly archived interactions, never original archived history", async () => {
    const { context, provider, summarizer, add, fill } = fixture();
    fill();
    const compactor = new ContextCompactor(provider, "system", () => 32_000);
    await compactor.prepare(input, [], new AbortController().signal, vi.fn());
    const firstSummary = context.snapshot().summary;
    for (let i = 0; i < 9; i++) add(`new-${i}`);
    await compactor.prepare(input, [], new AbortController().signal, vi.fn());
    const request = vi.mocked(summarizer.respond).mock.calls[1][0];
    if (request.kind !== "message") throw new Error("Expected summary message");
    const payload = JSON.parse(request.message.text) as {
      previousSummary: string;
    };
    expect(payload.previousSummary).toBe(firstSummary);
    expect(request.message.text).not.toContain("old-0");
    expect(request.message.text).toContain("old-8");
    expect(request.message.text).toContain("new-0");
    expect(request.message.text).not.toContain("new-8");
    expect(
      context.items.filter((item) =>
        String(item.content).includes("Historical conversation summary"),
      ),
    ).toHaveLength(1);
  });

  it("compresses older complete turns before a tool continuation without breaking the active turn", async () => {
    const { context, provider, fill } = fixture();
    fill();
    context.beginTurn();
    const active = [
      { role: "user", content: "current" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call", function: { name: "read_note", arguments: "{}" } },
        ],
      },
    ];
    context.append(...active);
    await new ContextCompactor(provider, "system", () => 32_000).prepare(
      { kind: "tool-results", results: [{ callId: "call", output: "result" }] },
      [],
      new AbortController().signal,
      vi.fn(),
    );
    expect(context.items.slice(-2)).toEqual(active);
    expect(context.snapshot().turns.at(-1)?.complete).toBe(false);
    context.abortTurn();
    expect(context.snapshot().summary).not.toBe("");
    expect(JSON.stringify(context.items)).not.toContain("current");
  });

  it.each(["empty", "oversized", "error", "tool", "cancelled", "reset"])(
    "does not install invalid summaries (%s)",
    async (mode) => {
      const { context, provider, summarizer, fill } = fixture();
      fill();
      const before = structuredClone(context.items);
      const controller = new AbortController();
      vi.mocked(summarizer.respond).mockImplementation(
        async (_input, _tools, handlers) => {
          if (mode === "error") throw new Error("summary service failed");
          if (mode === "cancelled") controller.abort();
          if (mode === "reset") context.reset();
          handlers.onTextDelta(
            mode === "empty"
              ? " "
              : mode === "oversized"
                ? "x".repeat(6001)
                : "small summary",
          );
          return {
            toolCalls:
              mode === "tool"
                ? [{ callId: "call", name: "write_note", arguments: "{}" }]
                : [],
          };
        },
      );
      const activity = vi.fn<(activity: ContextActivity) => void>();
      await expect(
        new ContextCompactor(provider, "system", () => 32_000).prepare(
          input,
          [],
          controller.signal,
          activity,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(context.snapshot().summary).toBe("");
      expect(context.items).toEqual(mode === "reset" ? [] : before);
      expect(provider.onContextReplaced).not.toHaveBeenCalled();
      expect(activity.mock.calls.at(-1)?.[0].status).toBe("error");
    },
  );

  it("rejects a single huge input or unfinished turn instead of invoking tools or silently truncating", async () => {
    const { context, provider } = fixture();
    const compactor = new ContextCompactor(provider, "system", () => 32_000);
    await expect(
      compactor.prepare(
        { kind: "message", message: { text: "x".repeat(100_000), images: [] } },
        [],
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("current message");
    context.beginTurn();
    context.append({ role: "user", content: "x".repeat(100_000) });
    await expect(
      compactor.prepare(input, [], new AbortController().signal, vi.fn()),
    ).rejects.toThrow("No completed");
    expect(provider.createSummaryProvider).not.toHaveBeenCalled();
  });

  it("calibrates underestimated inputs conservatively and resets on new conversation", async () => {
    const { provider, fill } = fixture();
    fill();
    const compactor = new ContextCompactor(provider, "system", () => 100_000);
    const estimate = await compactor.prepare(
      input,
      [],
      new AbortController().signal,
      vi.fn(),
    );
    compactor.observe({ inputTokens: estimate * 3 }, estimate);
    await compactor.prepare(input, [], new AbortController().signal, vi.fn());
    expect(provider.createSummaryProvider).toHaveBeenCalledTimes(1);
    compactor.reset();
    await compactor.prepare(input, [], new AbortController().signal, vi.fn());
    expect(provider.createSummaryProvider).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid-sized summary that does not reduce total input by at least 10%", async () => {
    const { context, provider, summarizer, add } = fixture();
    add("old", 13_000);
    context.beginTurn();
    context.append({ role: "user", content: "active" + "y".repeat(35_000) });
    const before = context.snapshot();
    vi.mocked(summarizer.respond).mockImplementation(
      async (_input, _tools, handlers) => {
        handlers.onTextDelta("s".repeat(5700));
        return { toolCalls: [] };
      },
    );
    await expect(
      new ContextCompactor(provider, "x".repeat(50_000), () => 32_000).prepare(
        input,
        [],
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("did not reduce");
    expect(context.snapshot()).toEqual(before);
    expect(provider.onContextReplaced).not.toHaveBeenCalled();
  });

  it("rechecks a changed budget before installing the summary", async () => {
    const { context, provider, summarizer, fill } = fixture();
    fill();
    const before = context.snapshot();
    let budget = 32_000;
    vi.mocked(summarizer.respond).mockImplementation(
      async (_input, _tools, handlers) => {
        budget = 8000;
        handlers.onTextDelta("x".repeat(5700));
        return { toolCalls: [] };
      },
    );
    await expect(
      new ContextCompactor(provider, "s".repeat(8000), () => budget).prepare(
        input,
        [],
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("did not reduce");
    expect(context.snapshot()).toEqual(before);
  });
});
