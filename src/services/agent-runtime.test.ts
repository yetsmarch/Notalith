import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../providers/provider";
import { defaultConnections } from "./provider-settings";
import { LocalAgentRuntime, type RuntimeHandlers } from "./agent-runtime";
import type { NotalithSettings, ProviderInput, ToolCall } from "../types";
import type { VaultService } from "./vault-service";
import { DEFAULT_IMAGE_SETTINGS } from "./image-settings";
import { ImageGenerationService } from "./image-generation";

const settings: NotalithSettings = {
  connections: defaultConnections(),
  models: [],
  activeModelId: "",
  systemPrompt: "prompt",
  includeEmbeddedImages: false,
  maxNoteCharacters: 1000,
  maxToolRounds: 2,
  attachmentFolder: "",
  imageGeneration: { ...DEFAULT_IMAGE_SETTINGS },
};

describe("local agent runtime", () => {
  it.each([false, true])(
    "advertises generate_image only when the independent service is configured (%s)",
    async (configured) => {
      const vault = {} as VaultService;
      const images = new ImageGenerationService({
        validateAttachmentDestination: vi.fn(),
        importAttachment: vi.fn(),
      });
      if (configured) images.configure({ generate: vi.fn() }, "");
      const provider: ModelProvider = {
        supportsImages: false,
        supportsImageToolResults: false,
        resetConversation: vi.fn(),
        finishTurn: vi.fn(),
        abortTurn: vi.fn(),
        testConnection: vi.fn(),
        respond: vi.fn<ModelProvider["respond"]>(async (_input, tools) => {
          expect(tools.some((tool) => tool.name === "generate_image")).toBe(
            configured,
          );
          return { toolCalls: [] };
        }),
      };
      await new LocalAgentRuntime(settings, vault, provider, images).send(
        "Hello",
        [],
        { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
        new AbortController().signal,
      );
    },
  );

  it("dispatches image generation for a non-vision chat provider and returns saved metadata", async () => {
    const artifact = {
      id: "image-1",
      status: "saved" as const,
      path: "Attachments/image.png",
      sourcePath: "Notes/current.md",
      embedLink: "![[Attachments/image.png]]",
    };
    const generate = vi
      .fn<ImageGenerationService["generate"]>()
      .mockResolvedValue(artifact);
    const images = new ImageGenerationService({
      validateAttachmentDestination: vi.fn(),
      importAttachment: vi.fn(),
    });
    images.configure({ generate: vi.fn() }, "");
    vi.spyOn(images, "generate").mockImplementation(generate);
    const onGeneratedImage = vi.fn();
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (input, tools, handlers) => {
          expect(tools.some((tool) => tool.name === "generate_image")).toBe(
            true,
          );
          if (input.kind === "message")
            handlers.onToolCall({
              callId: "image-call",
              name: "generate_image",
              arguments:
                '{"prompt":"Blue sky","filename":null,"sourcePath":null}',
            });
          else
            expect(input.results).toEqual([
              {
                callId: "image-call",
                output: JSON.stringify({ images: [artifact] }),
              },
            ]);
          return { toolCalls: [] };
        },
      ),
    };
    const signal = new AbortController().signal;
    await new LocalAgentRuntime(
      settings,
      {} as VaultService,
      provider,
      images,
    ).send(
      "Generate an image",
      [],
      {
        onTextDelta: vi.fn(),
        onToolActivity: vi.fn(),
        onUsage: vi.fn(),
        onGeneratedImage,
      },
      signal,
      "Notes/current.md",
    );
    expect(generate).toHaveBeenCalledWith(
      "Blue sky",
      null,
      "Notes/current.md",
      signal,
    );
    expect(onGeneratedImage).toHaveBeenCalledWith(artifact);
  });

  it("does not let the model automatically retry a billed image failure in the same turn", async () => {
    const images = new ImageGenerationService({
      validateAttachmentDestination: vi.fn(),
      importAttachment: vi.fn(),
    });
    images.configure({ generate: vi.fn() }, "");
    const generate = vi
      .spyOn(images, "generate")
      .mockRejectedValue(new Error("Image request timed out"));
    let round = 0;
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (input, _tools, handlers) => {
          if (round++ < 2)
            handlers.onToolCall({
              callId: `call-${round}`,
              name: "generate_image",
              arguments: '{"prompt":"Sky","filename":null,"sourcePath":null}',
            });
          else if (input.kind === "tool-results")
            expect(input.results[0].output).toContain(
              "Do not retry automatically",
            );
          return { toolCalls: [] };
        },
      ),
    };
    await new LocalAgentRuntime(
      settings,
      {} as VaultService,
      provider,
      images,
    ).send(
      "Generate an image",
      [],
      { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
      new AbortController().signal,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("advertises and dispatches every P0 tool with pagination and range arguments", async () => {
    const listEntries = vi.fn(() => ({ items: [], nextOffset: null }));
    const readTextFile = vi.fn(async () => ({
      content: "text",
      nextOffset: null,
    }));
    const getActiveNote = vi.fn(() => ({ path: "Note.md" }));
    const getEditorContext = vi.fn(() => ({
      path: "Note.md",
      cursor: { line: 1, ch: 2 },
      positionBase: 0,
    }));
    const resolveWikilink = vi.fn(async () => ({
      path: "Note.md",
      startLine: 2,
      endLine: 4,
    }));
    const createFolder = vi.fn(async () => "Empty");
    const cases = [
      [
        "list_directory",
        { folder: null, kind: "folder", offset: 2, limit: 10 },
      ],
      [
        "get_directory_tree",
        { folder: "Notes", kind: null, offset: null, limit: null },
      ],
      [
        "read_note_range",
        { path: "Note.md", startLine: 2, endLine: 4, offset: 5 },
      ],
      [
        "read_text_file",
        { path: "data.csv", startLine: null, endLine: null, offset: null },
      ],
      ["get_active_note", {}],
      ["get_editor_selection", {}],
      ["get_cursor_position", {}],
      ["resolve_wikilink", { link: "[[Alias#Title]]", sourcePath: "Note.md" }],
      ["create_folder", { path: "Empty" }],
    ] as const;
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (input, tools, handlers) => {
          if (input.kind === "message") {
            for (const [name, args] of cases) {
              expect(tools.some((tool) => tool.name === name)).toBe(true);
              handlers.onToolCall({
                callId: name,
                name,
                arguments: JSON.stringify(args),
              });
            }
          } else {
            expect(input.results).toHaveLength(cases.length);
            for (const result of input.results)
              expect(result.output).not.toContain('"error"');
          }
          return { toolCalls: [] };
        },
      ),
    };
    const vault = {
      listEntries,
      readTextFile,
      getActiveNote,
      getEditorContext,
      resolveWikilink,
      createFolder,
    } as unknown as VaultService;
    const signal = new AbortController().signal;
    await new LocalAgentRuntime(settings, vault, provider).send(
      "Use P0 tools",
      [],
      { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
      signal,
    );
    expect(listEntries).toHaveBeenCalledWith("", false, "folder", 2, 10);
    expect(listEntries).toHaveBeenCalledWith("Notes", true, "all", 0, 100);
    expect(readTextFile).toHaveBeenCalledWith("Note.md", 1000, 2, 4, 5, true);
    expect(readTextFile).toHaveBeenCalledWith(
      "data.csv",
      1000,
      1,
      null,
      0,
      false,
    );
    expect(resolveWikilink).toHaveBeenCalledWith("[[Alias#Title]]", "Note.md");
    expect(createFolder).toHaveBeenCalledWith("Empty", signal);
    expect(getEditorContext).toHaveBeenCalledTimes(2);
  });

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

describe("local knowledge and advanced search runtime wiring", () => {
  it("advertises and dispatches every new local tool with strict arguments", async () => {
    const vault = {
      getBacklinks: vi.fn(() => ({ items: [], nextOffset: null })),
      getOutgoingLinks: vi.fn(() => ({ items: [], nextOffset: null })),
      getUnresolvedLinks: vi.fn(() => ({ items: [], nextOffset: null })),
      getTagIndex: vi.fn(() => ({ items: [], nextOffset: null })),
      getNoteOutline: vi.fn(() => ({ items: [], nextOffset: null })),
      generateAttachmentLink: vi.fn(() => ({ link: "[[file.pdf]]" })),
      searchNotesAdvanced: vi.fn(async () => ({ items: [], nextOffset: null })),
    };
    const search = {
      query: "^item",
      regex: true,
      caseSensitive: false,
      folder: "Notes",
      tags: ["work"],
      properties: [{ key: "status", operator: "equals", value: "ready" }],
      createdAfter: "2026-01-01",
      createdBefore: null,
      modifiedAfter: null,
      modifiedBefore: null,
      offset: 2,
      limit: 5,
    };
    const cases = [
      ["get_backlinks", { path: "a.md", offset: 2, limit: 5 }],
      ["get_outgoing_links", { path: "a.md", offset: null, limit: null }],
      ["get_unresolved_links", { path: null, offset: null, limit: null }],
      ["list_tags", { prefix: "work", offset: 2, limit: 5 }],
      ["get_note_outline", { path: "a.md", offset: 2, limit: 5 }],
      [
        "get_attachment_link",
        { path: "file.pdf", sourcePath: "a.md", embed: true },
      ],
      ["search_notes", search],
    ] as const;
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond: vi.fn<ModelProvider["respond"]>(
        async (input, tools, handlers) => {
          if (input.kind === "message") {
            for (const [name, args] of cases) {
              expect(tools.some((tool) => tool.name === name)).toBe(true);
              handlers.onToolCall({
                name,
                callId: name,
                arguments: JSON.stringify(args),
              });
            }
          } else {
            expect(input.results).toHaveLength(cases.length);
            expect(
              input.results.every(
                (result) =>
                  typeof result.output === "string" &&
                  !result.output.includes('"error"'),
              ),
            ).toBe(true);
          }
          return { toolCalls: [] };
        },
      ),
    };
    const signal = new AbortController().signal;
    await new LocalAgentRuntime(
      settings,
      vault as unknown as VaultService,
      provider,
    ).send(
      "test",
      [],
      { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
      signal,
    );
    expect(vault.getBacklinks).toHaveBeenCalledWith("a.md", 2, 5);
    expect(vault.getOutgoingLinks).toHaveBeenCalledWith("a.md", 0, 100);
    expect(vault.getUnresolvedLinks).toHaveBeenCalledWith(null, 0, 100);
    expect(vault.getTagIndex).toHaveBeenCalledWith("work", 2, 5);
    expect(vault.getNoteOutline).toHaveBeenCalledWith("a.md", 2, 5);
    expect(vault.generateAttachmentLink).toHaveBeenCalledWith(
      "file.pdf",
      "a.md",
      true,
    );
    expect(vault.searchNotesAdvanced).toHaveBeenCalledWith(search, signal);
  });

  it("surfaces invalid search filters as tool errors instead of silently defaulting", async () => {
    const invalid = [
      { regex: "true" },
      { query: 12 },
      { tags: [""] },
      { tags: "work" },
      { properties: [{ key: "status", operator: "unknown", value: "x" }] },
      {
        properties: [
          { key: "__proto__.hidden", operator: "exists", value: null },
        ],
      },
      { properties: [{ key: "count", operator: "gt", value: "4" }] },
      { limit: 201 },
      { offset: -1 },
      { createdAfter: 2026 },
    ];
    const searchNotesAdvanced = vi.fn();
    const activity = vi.fn<RuntimeHandlers["onToolActivity"]>();
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
            invalid.forEach((args, i) =>
              handlers.onToolCall({
                name: "search_notes",
                callId: String(i),
                arguments: JSON.stringify(args),
              }),
            );
          else
            expect(
              input.results.every(
                (result) =>
                  typeof result.output === "string" &&
                  result.output.includes('"error"'),
              ),
            ).toBe(true);
          return { toolCalls: [] };
        },
      ),
    };
    await new LocalAgentRuntime(
      settings,
      { searchNotesAdvanced } as unknown as VaultService,
      provider,
    ).send(
      "test",
      [],
      { onTextDelta: vi.fn(), onToolActivity: activity, onUsage: vi.fn() },
      new AbortController().signal,
    );
    expect(searchNotesAdvanced).not.toHaveBeenCalled();
    expect(
      activity.mock.calls.filter(([item]) => item.status === "error"),
    ).toHaveLength(invalid.length);
  });

  it("sends extracted text but only a reference for unsupported imported files", async () => {
    const readTextFile = vi.fn(async () => ({
      content: "A,B\n1,2",
      nextOffset: 1000,
    }));
    const readNote = vi.fn();
    const respond = vi.fn<ModelProvider["respond"]>(async (input) => {
      expect(input.kind).toBe("message");
      if (input.kind === "message") {
        expect(input.message.text).toContain(
          '<vault_text path="data.csv" truncated="true">',
        );
        expect(input.message.text).toContain("A,B\n1,2");
        expect(input.message.text).toContain(
          '<vault_file path="file.pdf">Stored file reference only.',
        );
        expect(input.message.images).toEqual([]);
      }
      return { toolCalls: [] };
    });
    const provider: ModelProvider = {
      supportsImages: false,
      supportsImageToolResults: false,
      resetConversation: vi.fn(),
      finishTurn: vi.fn(),
      abortTurn: vi.fn(),
      testConnection: vi.fn(),
      respond,
    };
    await new LocalAgentRuntime(
      settings,
      { readTextFile, readNote } as unknown as VaultService,
      provider,
    ).send(
      "test",
      [
        { id: "1", kind: "text", path: "data.csv", name: "data.csv" },
        { id: "2", kind: "file", path: "file.pdf", name: "file.pdf" },
      ],
      { onTextDelta: vi.fn(), onToolActivity: vi.fn(), onUsage: vi.fn() },
      new AbortController().signal,
    );
    expect(readTextFile).toHaveBeenCalledWith("data.csv", 1000);
    expect(readNote).not.toHaveBeenCalled();
  });
});
