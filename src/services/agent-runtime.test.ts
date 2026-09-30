import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../providers/provider";
import { defaultConnections } from "./provider-settings";
import { LocalAgentRuntime, type RuntimeHandlers } from "./agent-runtime";
import type { NotalithSettings, ProviderInput, ToolCall } from "../types";
import type { VaultService } from "./vault-service";

const settings: NotalithSettings = {
  connections: defaultConnections(),
  models: [],
  activeModelId: "",
  systemPrompt: "prompt",
  includeEmbeddedImages: false,
  maxNoteCharacters: 1000,
  maxToolRounds: 2,
};

describe("local agent runtime", () => {
  it("advertises all Markdown writes and executes them with exact text arguments", async () => {
    const createMarkdownNote = vi.fn(async () => "New.md");
    const appendMarkdownNote = vi.fn(async () => "New.md");
    const replaceMarkdownText = vi.fn(async () => "New.md");
    const calls: ToolCall[] = [
      {
        callId: "create",
        name: "create_note",
        arguments: '{"path":"New.md","content":""}',
      },
      {
        callId: "append",
        name: "append_note",
        arguments: '{"path":"New.md","content":"  content  "}',
      },
      {
        callId: "replace",
        name: "replace_note_text",
        arguments: '{"path":"New.md","oldText":"  content  ","newText":""}',
      },
    ];
    const inputs: ProviderInput[] = [];
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (input, tools, handlers) => {
          inputs.push(input);
          expect(
            tools
              .filter((tool) => calls.some((call) => call.name === tool.name))
              .map((tool) => tool.name),
          ).toEqual(["create_note", "append_note", "replace_note_text"]);
          if (input.kind === "message")
            calls.forEach((call) => handlers.onToolCall(call));
          return { toolCalls: [] };
        },
      ),
    };
    const vault = {
      createMarkdownNote,
      appendMarkdownNote,
      replaceMarkdownText,
    } as unknown as VaultService;
    const onToolActivity = vi.fn();
    const controller = new AbortController();
    await new LocalAgentRuntime(settings, vault, provider).send(
      "Edit note",
      [],
      { onTextDelta: vi.fn(), onToolActivity, onUsage: vi.fn() },
      controller.signal,
    );
    expect(createMarkdownNote).toHaveBeenCalledWith(
      "New.md",
      "",
      controller.signal,
    );
    expect(appendMarkdownNote).toHaveBeenCalledWith(
      "New.md",
      "  content  ",
      controller.signal,
    );
    expect(replaceMarkdownText).toHaveBeenCalledWith(
      "New.md",
      "  content  ",
      "",
      controller.signal,
    );
    expect(inputs[1]).toEqual({
      kind: "tool-results",
      results: [
        { callId: "create", output: '{"path":"New.md","action":"created"}' },
        { callId: "append", output: '{"path":"New.md","action":"appended"}' },
        { callId: "replace", output: '{"path":"New.md","action":"replaced"}' },
      ],
    });
    expect(onToolActivity).toHaveBeenCalledWith({
      name: "replace_note_text",
      status: "complete",
      summary: "replace_note_text: New.md",
    });
  });

  it("reports invalid write arguments and write failures without claiming success", async () => {
    const createMarkdownNote = vi.fn(async () => {
      throw new Error("Note already exists");
    });
    const calls: ToolCall[] = [
      {
        callId: "bad",
        name: "append_note",
        arguments: '{"path":"a.md","content":1}',
      },
      {
        callId: "exists",
        name: "create_note",
        arguments: '{"path":"a.md","content":"new"}',
      },
    ];
    let results: ProviderInput | undefined;
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (input, _tools, handlers) => {
          if (input.kind === "message")
            calls.forEach((call) => handlers.onToolCall(call));
          else results = input;
          return { toolCalls: [] };
        },
      ),
    };
    const onToolActivity = vi.fn<RuntimeHandlers["onToolActivity"]>();
    await new LocalAgentRuntime(
      settings,
      { createMarkdownNote } as unknown as VaultService,
      provider,
    ).send(
      "Edit note",
      [],
      { onTextDelta: vi.fn(), onToolActivity, onUsage: vi.fn() },
      new AbortController().signal,
    );
    expect(results).toEqual({
      kind: "tool-results",
      results: [
        {
          callId: "bad",
          output: '{"error":"content must be a non-empty string."}',
        },
        { callId: "exists", output: '{"error":"Note already exists"}' },
      ],
    });
    expect(
      onToolActivity.mock.calls.filter(
        ([activity]) => activity.status === "error",
      ),
    ).toHaveLength(2);
  });

  it("does not execute later writes after cancellation", async () => {
    const controller = new AbortController();
    const createMarkdownNote = vi.fn(async () => {
      controller.abort();
      return "a.md";
    });
    const appendMarkdownNote = vi.fn();
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (_input, _tools, handlers) => {
          handlers.onToolCall({
            callId: "1",
            name: "create_note",
            arguments: '{"path":"a.md","content":"x"}',
          });
          handlers.onToolCall({
            callId: "2",
            name: "append_note",
            arguments: '{"path":"a.md","content":"y"}',
          });
          return { toolCalls: [] };
        },
      ),
    };
    await expect(
      new LocalAgentRuntime(
        settings,
        { createMarkdownNote, appendMarkdownNote } as unknown as VaultService,
        provider,
      ).send(
        "Edit note",
        [],
        { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
        controller.signal,
      ),
    ).rejects.toThrow("Request cancelled.");
    expect(createMarkdownNote).toHaveBeenCalledOnce();
    expect(appendMarkdownNote).not.toHaveBeenCalled();
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    "does not advertise or execute read_image with image input=%s and image tool results=%s",
    async (supportsImages, supportsImageToolResults) => {
      const abortTurn = vi.fn();
      const readImage = vi.fn();
      const provider: ModelProvider = {
        supportsImages,
        supportsImageToolResults,
        resetConversation: vi.fn(),
        finishTurn: vi.fn(),
        abortTurn,
        testConnection: vi.fn(),
        respond: vi.fn<ModelProvider["respond"]>(
          async (_input, tools, handlers) => {
            expect(tools.some((tool) => tool.name === "read_image")).toBe(
              false,
            );
            handlers.onToolCall({
              callId: "call-1",
              name: "read_image",
              arguments: '{"path":"private.png"}',
            });
            return { toolCalls: [] };
          },
        ),
      };
      const vault = { readImage } as unknown as VaultService;
      const runtime = new LocalAgentRuntime(settings, vault, provider);
      await expect(
        runtime.send(
          "Read private.png",
          [],
          { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
          new AbortController().signal,
        ),
      ).rejects.toThrow("unavailable tool: read_image");
      expect(readImage).not.toHaveBeenCalled();
      expect(abortTurn).toHaveBeenCalledOnce();
    },
  );
});
