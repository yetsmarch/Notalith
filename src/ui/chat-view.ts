import {
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type {
  ChatMessage,
  ContextAttachment,
  GeneratedImageArtifact,
  ProviderUsage,
} from "../types";
import type NotalithPlugin from "../main";
import { PROVIDER_IDS, PROVIDER_NAMES } from "../services/provider-settings";
import { createId } from "../services/id-utils";
import { imageMimeType, isTextExtension } from "../services/path-utils";
import { isOfficeExtension } from "../services/office-document-service";
import { ImageSaveError } from "../services/image-generation";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
} from "../services/vault-service";

export const NOTALITH_VIEW_TYPE = "notalith-chat";

interface ToolActivity {
  name: string;
  status: "running" | "complete" | "error";
  summary: string;
}

interface UiChatMessage extends ChatMessage {
  createdAt: number;
  attachments?: ContextAttachment[];
  toolActivities?: ToolActivity[];
  error?: string;
  generatedImages?: GeneratedImageArtifact[];
}

class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void,
    plugin: NotalithPlugin,
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose a vault file...");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

export class NotalithChatView extends ItemView {
  private messages: UiChatMessage[] = [];
  private attachments: ContextAttachment[] = [];
  private messageList: HTMLElement | null = null;
  private attachmentList: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private abortController: AbortController | null = null;
  private modelSelect: HTMLElement | null = null;
  private shownModelId = "";
  private shownConversationEpoch = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: NotalithPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return NOTALITH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Notalith";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  focusInput(): void {
    this.textarea?.focus();
  }

  startNewChat(): void {
    this.newChat();
  }

  refreshModelMenu(): void {
    if (
      this.shownConversationEpoch !== this.plugin.conversationEpoch ||
      this.shownModelId !== this.plugin.settings.activeModelId
    ) {
      this.newChat();
    } else if (this.modelSelect) {
      this.modelSelect.empty();
      this.renderModelSelect(this.modelSelect);
    }
  }

  private renderShell(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("notalith-view");

    const header = root.createDiv({ cls: "notalith-header" });
    header.createDiv({ cls: "notalith-title", text: "Notalith" });
    const newChat = header.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChat, "message-square-plus");
    newChat.addEventListener("click", () => this.newChat());

    this.messageList = root.createDiv({ cls: "notalith-messages" });
    const empty = this.messageList.createDiv({ cls: "notalith-empty" });
    const icon = empty.createDiv({ cls: "notalith-empty-icon" });
    setIcon(icon, "bot");
    empty.createEl("h3", { text: "Chat with your vault" });
    empty.createEl("p", {
      text: "Attach or import files. Notalith can search your vault, explore note relationships, and edit Markdown.",
    });

    const composer = root.createDiv({ cls: "notalith-composer" });
    this.attachmentList = composer.createDiv({
      cls: "notalith-attachments",
    });
    this.textarea = composer.createEl("textarea", {
      cls: "notalith-input",
      attr: {
        placeholder: "Ask about your vault...",
        rows: "3",
        "aria-label": "Message",
      },
    });
    this.textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });

    const toolbar = composer.createDiv({ cls: "notalith-toolbar" });
    const attachmentActions = toolbar.createDiv({
      cls: "notalith-toolbar-group",
    });
    this.iconButton(
      attachmentActions,
      "file-text",
      "Attach current note",
      () => void this.attachCurrentNote(),
    );
    this.iconButton(
      attachmentActions,
      "text-select",
      "Attach editor selection",
      () => void this.attachSelection(),
    );
    this.iconButton(attachmentActions, "paperclip", "Choose vault file", () =>
      this.chooseVaultFile(),
    );
    const fileInput = attachmentActions.createEl("input", {
      cls: "notalith-file-input",
      attr: {
        type: "file",
        multiple: "",
        "aria-label": "Import files into vault",
      },
    });
    const importButton = this.iconButton(
      attachmentActions,
      "upload",
      "Import files into vault",
      () => fileInput.click(),
    );
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = "";
      void this.importFiles(files, importButton);
    });

    const responseActions = toolbar.createDiv({
      cls: "notalith-toolbar-group notalith-response-actions",
    });
    this.modelSelect = responseActions.createDiv({
      cls: "notalith-model-select",
    });
    this.shownModelId = this.plugin.settings.activeModelId;
    this.shownConversationEpoch = this.plugin.conversationEpoch;
    this.renderModelSelect(this.modelSelect);
    this.sendButton = this.iconButton(
      responseActions,
      "send",
      "Send message",
      () => void this.send(),
      "notalith-send",
    );
    this.renderAttachments();
    const pending = this.plugin.imageService?.pendingArtifact;
    if (pending) {
      const message: UiChatMessage = {
        id: createId(),
        role: "assistant",
        text: "A generated image is waiting to be saved.",
        createdAt: Date.now(),
        generatedImages: [pending],
      };
      this.messages.push(message);
      void this.renderMessage(message).then(() => {
        const el =
          this.messageList?.querySelector<HTMLElement>(
            `[data-message-id="${message.id}"]`,
          ) ?? null;
        this.renderGeneratedImages(el, message);
        void this.renderAssistantBody(el, message);
      });
    }
  }

  private renderModelSelect(parent: HTMLElement): void {
    const models = this.plugin.settings.models.filter((model) => model.modelId);
    const current = this.plugin.getActiveModel();
    const button = parent.createEl("button", {
      cls: "notalith-model-menu",
      attr: {
        type: "button",
        "aria-label": "Select model",
        title: "Select model",
      },
    });
    button.createSpan({
      cls: "notalith-model-menu-label",
      text: current
        ? `${PROVIDER_NAMES[current.connectionId]} · ${current.displayName || current.modelId}`
        : "Select model",
    });
    const chevron = button.createSpan({
      cls: "notalith-model-menu-chevron",
    });
    setIcon(chevron, "chevron-down");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (this.abortController) {
        new Notice("Stop the current response before switching models.");
        return;
      }
      const menu = new Menu();
      if (models.length === 0) {
        menu.addItem((item) =>
          item.setTitle("Add a model in plugin settings").setIsLabel(true),
        );
      }
      for (const providerId of PROVIDER_IDS) {
        const providerModels = models.filter(
          (model) => model.connectionId === providerId,
        );
        if (!providerModels.length) continue;
        menu.addItem((item) =>
          item.setTitle(PROVIDER_NAMES[providerId]).setIsLabel(true),
        );
        for (const model of providerModels) {
          menu.addItem((item) =>
            item
              .setTitle(model.displayName || model.modelId)
              .setChecked(model.id === this.plugin.settings.activeModelId)
              .onClick(async () => {
                try {
                  await this.plugin.selectModel(model.id);
                  new Notice(
                    `Using model: ${PROVIDER_NAMES[providerId]} · ${model.displayName || model.modelId}`,
                  );
                } catch (error) {
                  new Notice(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }),
          );
        }
      }
      menu.showAtMouseEvent(event);
      button.blur();
    });
  }

  private iconButton(
    parent: HTMLElement,
    iconName: string,
    label: string,
    action: () => void,
    className = "",
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: `clickable-icon ${className}`,
      attr: { "aria-label": label },
    });
    setIcon(button, iconName);
    button.addEventListener("click", action);
    return button;
  }

  private async send(): Promise<void> {
    const prompt = this.textarea?.value.trim() ?? "";
    if (!prompt || this.abortController) return;
    const runtime = this.plugin.runtime;
    const active = this.app.workspace.getActiveFile();
    const sourcePath = active?.extension === "md" ? active.path : "";
    if (!this.plugin.isConfigured() || !runtime) {
      new Notice(
        "Configure a model, endpoint, and API key in Notalith settings.",
      );
      return;
    }

    const userMessage: UiChatMessage = {
      id: createId(),
      role: "user",
      text: prompt,
      createdAt: Date.now(),
      attachments: [...this.attachments],
    };
    const assistantMessage: UiChatMessage = {
      id: createId(),
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      toolActivities: [],
      generatedImages: [],
    };
    this.messages.push(userMessage, assistantMessage);
    this.attachments = [];
    if (this.textarea) this.textarea.value = "";
    this.renderAttachments();
    await this.renderMessage(userMessage);
    await this.renderMessage(assistantMessage);
    this.scrollToBottom();

    this.abortController = new AbortController();
    this.updateSendButton(true);
    const assistantEl = this.messageList?.querySelector(
      `[data-message-id="${assistantMessage.id}"]`,
    ) as HTMLElement | null;

    try {
      await runtime.send(
        prompt,
        userMessage.attachments ?? [],
        {
          onTextDelta: (delta) => {
            assistantMessage.text += delta;
            void this.renderAssistantBody(assistantEl, assistantMessage);
          },
          onToolActivity: (activity) => {
            const existing = assistantMessage.toolActivities?.find(
              (item) =>
                item.name === activity.name && item.status === "running",
            );
            if (existing) Object.assign(existing, activity);
            else assistantMessage.toolActivities?.push(activity);
            this.renderToolActivities(assistantEl, assistantMessage);
          },
          onUsage: (usage) => this.renderUsage(assistantEl, usage),
          onContextActivity: (activity) => {
            const name = "context_compaction";
            const existing = assistantMessage.toolActivities?.find(
              (item) => item.name === name && item.status === "running",
            );
            const item = {
              name,
              status: activity.status,
              summary: activity.message,
            };
            if (existing) Object.assign(existing, item);
            else assistantMessage.toolActivities?.push(item);
            this.renderToolActivities(assistantEl, assistantMessage);
          },
          onGeneratedImage: (artifact) => {
            assistantMessage.generatedImages?.push(artifact);
            this.renderGeneratedImages(assistantEl, assistantMessage);
          },
        },
        this.abortController.signal,
        sourcePath,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "Request cancelled.") {
        assistantMessage.error = message;
        this.renderError(assistantEl, message);
      }
    } finally {
      this.abortController = null;
      this.updateSendButton(false);
      this.scrollToBottom();
    }
  }

  private async renderMessage(message: UiChatMessage): Promise<void> {
    if (!this.messageList) return;
    this.messageList.querySelector(".notalith-empty")?.remove();
    const container = this.messageList.createDiv({
      cls: `notalith-message is-${message.role}`,
      attr: { "data-message-id": message.id },
    });

    if (message.attachments?.length) {
      const list = container.createDiv({ cls: "notalith-message-context" });
      for (const attachment of message.attachments) {
        list.createSpan({
          text: attachment.name,
          cls: "notalith-context-chip",
        });
      }
    }

    const body = container.createDiv({ cls: "notalith-message-body" });
    if (message.role === "assistant") {
      body.createDiv({
        cls: "notalith-thinking",
        text: "Thinking...",
      });
    } else {
      body.setText(message.text);
    }
  }

  private async renderAssistantBody(
    messageEl: HTMLElement | null,
    message: UiChatMessage,
  ): Promise<void> {
    const body = messageEl?.querySelector(
      ".notalith-message-body",
    ) as HTMLElement | null;
    if (!body) return;
    body.empty();
    if (!message.text) {
      body.createDiv({ cls: "notalith-thinking", text: "Thinking..." });
      return;
    }
    await MarkdownRenderer.render(this.app, message.text, body, "", this);
    this.scrollToBottom();
  }

  private renderToolActivities(
    messageEl: HTMLElement | null,
    message: UiChatMessage,
  ): void {
    if (!messageEl) return;
    let section = messageEl.querySelector<HTMLElement>(".notalith-tools");
    if (!section) section = messageEl.createDiv({ cls: "notalith-tools" });
    section.empty();

    for (const activity of message.toolActivities ?? []) {
      const row = section.createDiv({
        cls: `notalith-tool is-${activity.status}`,
      });
      const icon = row.createSpan({ cls: "notalith-tool-icon" });
      setIcon(
        icon,
        activity.status === "running"
          ? "loader-circle"
          : activity.status === "complete"
            ? "check"
            : "triangle-alert",
      );
      row.createSpan({ text: activity.summary });
    }
    this.scrollToBottom();
  }

  private renderUsage(
    messageEl: HTMLElement | null,
    usage: ProviderUsage,
  ): void {
    if (!messageEl || !usage.totalTokens) return;
    let el = messageEl.querySelector<HTMLElement>(".notalith-usage");
    if (!el) el = messageEl.createDiv({ cls: "notalith-usage" });
    el.setText(`${usage.totalTokens.toLocaleString()} tokens`);
  }

  updateGeneratedImage(artifact: GeneratedImageArtifact): void {
    for (const message of this.messages) {
      const index =
        message.generatedImages?.findIndex(
          (image) => image.id === artifact.id,
        ) ?? -1;
      if (index < 0 || !message.generatedImages) continue;
      message.generatedImages[index] = artifact;
      const el =
        this.messageList?.querySelector<HTMLElement>(
          `[data-message-id="${message.id}"]`,
        ) ?? null;
      this.renderGeneratedImages(el, message);
    }
  }

  removeGeneratedImage(id: string): void {
    for (const message of this.messages) {
      if (!message.generatedImages?.some((image) => image.id === id)) continue;
      message.generatedImages = message.generatedImages.filter(
        (image) => image.id !== id,
      );
      const el =
        this.messageList?.querySelector<HTMLElement>(
          `[data-message-id="${message.id}"]`,
        ) ?? null;
      this.renderGeneratedImages(el, message);
    }
  }

  private renderGeneratedImages(
    messageEl: HTMLElement | null,
    message: UiChatMessage,
  ): void {
    if (!messageEl) return;
    let section = messageEl.querySelector<HTMLElement>(
      ".notalith-generated-images",
    );
    if (!section)
      section = messageEl.createDiv({ cls: "notalith-generated-images" });
    section.empty();
    for (const artifact of message.generatedImages ?? []) {
      const card = section.createDiv({ cls: "notalith-generated-image" });
      const actions = card.createDiv({
        cls: "notalith-generated-image-actions",
      });
      try {
        const file =
          artifact.status === "saved"
            ? this.app.vault.getAbstractFileByPath(artifact.path)
            : null;
        if (artifact.status === "saved" && !(file instanceof TFile)) {
          throw new Error(`Generated image no longer exists: ${artifact.path}`);
        }
        const src =
          file instanceof TFile
            ? this.app.vault.getResourcePath(file)
            : this.plugin.imageService.pendingPreview(artifact.id);
        card.createEl("img", { attr: { src, alt: "Generated image" } });
        if (artifact.status === "saved") {
          card.createDiv({
            cls: "notalith-generated-image-path",
            text: artifact.path,
          });
          this.imageAction(actions, "Copy embed link", async () => {
            const { link } = this.plugin.vaultService.generateAttachmentLink(
              artifact.path,
              artifact.sourcePath,
              true,
            );
            await navigator.clipboard.writeText(link);
            new Notice("Image embed link copied.");
          });
          this.imageAction(actions, "Insert into note", async () => {
            new VaultFileSuggestModal(
              this.app.vault.getMarkdownFiles(),
              (note) => {
                void (async () => {
                  try {
                    const { link } =
                      this.plugin.vaultService.generateAttachmentLink(
                        artifact.path,
                        note.path,
                        true,
                      );
                    await this.plugin.vaultService.appendMarkdownNote(
                      note.path,
                      link,
                      new AbortController().signal,
                    );
                    new Notice(`Image appended to ${note.path}`);
                  } catch (error) {
                    console.error("[Notalith] Image insertion failed", error);
                    new Notice(
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                })();
              },
              this.plugin,
            ).open();
          });
        } else {
          card.createDiv({
            cls: "notalith-error",
            text: `Generated but not saved: ${artifact.error}. The image is retained only in memory.`,
          });
          this.imageAction(actions, "Retry save", async () => {
            try {
              const saved = await this.plugin.imageService.retrySave(
                artifact.id,
                new AbortController().signal,
              );
              this.plugin.refreshGeneratedImage(saved);
            } catch (error) {
              if (error instanceof ImageSaveError)
                this.plugin.refreshGeneratedImage(error.artifact);
              throw error;
            }
          });
          this.imageAction(actions, "Discard", async () => {
            this.plugin.imageService.discard(artifact.id);
            this.plugin.removeGeneratedImage(artifact.id);
          });
        }
      } catch (error) {
        card.createDiv({
          cls: "notalith-error",
          text: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.scrollToBottom();
  }

  private imageAction(
    parent: HTMLElement,
    label: string,
    action: () => Promise<void>,
  ): void {
    const button = parent.createEl("button", {
      text: label,
      attr: { type: "button" },
    });
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true;
        try {
          await action();
        } catch (error) {
          console.error("[Notalith] Generated image action failed", error);
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          button.disabled = false;
        }
      })();
    });
  }

  private renderError(messageEl: HTMLElement | null, message: string): void {
    if (!messageEl) return;
    messageEl.createDiv({ cls: "notalith-error", text: message });
  }

  private async attachCurrentNote(): Promise<void> {
    const attachment = this.plugin.vaultService.getActiveNoteAttachment();
    if (!attachment) {
      new Notice("No active Markdown note.");
      return;
    }
    this.addAttachment(attachment);
  }

  private async attachSelection(): Promise<void> {
    const attachment = this.plugin.vaultService.getActiveSelectionAttachment();
    if (!attachment) {
      new Notice("Select text in an active Markdown editor first.");
      return;
    }
    this.addAttachment(attachment);
  }

  private chooseVaultFile(): void {
    const files = this.plugin.vaultService.listAttachableFiles();
    new VaultFileSuggestModal(
      files,
      (file) => void this.attachFile(file),
      this.plugin,
    ).open();
  }

  private async attachFile(file: TFile): Promise<void> {
    try {
      const image = imageMimeType(file.extension);
      const office = isOfficeExtension(file.extension);
      const attachment: ContextAttachment =
        image && file.stat.size <= MAX_IMAGE_BYTES
          ? {
              id: createId(),
              kind: "image",
              path: file.path,
              name: file.name,
              ...(await this.plugin.vaultService.readImage(file.path)),
            }
          : office
            ? {
                id: createId(),
                kind: "document",
                path: file.path,
                name: file.name,
              }
            : {
                id: createId(),
                kind:
                  file.extension === "md"
                    ? "note"
                    : isTextExtension(file.extension)
                      ? "text"
                      : "file",
                path: file.path,
                name: file.extension === "md" ? file.basename : file.name,
              };
      this.addAttachment(attachment);
      if (attachment.kind === "file")
        new Notice(
          image
            ? `${file.name}: imported as a reference only; image input is limited to 10 MB.`
            : `${file.name}: stored file reference only; content extraction is not supported for this format.`,
        );
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async importFiles(
    files: File[],
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    const active = this.app.workspace.getActiveFile();
    const sourcePath = active?.extension === "md" ? active.path : "";
    try {
      for (const file of files) {
        try {
          if (file.size > MAX_ATTACHMENT_BYTES)
            throw new Error(`${file.name}: attachment exceeds 25 MB.`);
          const imported = await this.plugin.vaultService.importAttachment(
            file.name,
            await file.arrayBuffer(),
            this.plugin.settings.attachmentFolder,
            sourcePath,
          );
          new Notice(`Imported ${imported.file.path}`);
          await this.attachFile(imported.file);
        } catch (error) {
          console.error("[Notalith] Attachment import failed", error);
          new Notice(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      button.disabled = false;
    }
  }

  private addAttachment(attachment: ContextAttachment): void {
    if (
      this.attachments.some(
        (item) =>
          item.kind === attachment.kind && item.path === attachment.path,
      )
    ) {
      return;
    }
    this.attachments.push(attachment);
    this.renderAttachments();
  }

  private renderAttachments(): void {
    if (!this.attachmentList) return;
    this.attachmentList.empty();
    this.attachmentList.toggleClass("is-empty", this.attachments.length === 0);

    this.attachments.forEach((attachment, index) => {
      const chip = this.attachmentList?.createDiv({
        cls: "notalith-attachment",
      });
      chip?.createSpan({ text: attachment.name });
      if (chip && attachment.kind !== "selection") {
        this.iconButton(chip, "link", `Copy link to ${attachment.name}`, () => {
          void (async () => {
            try {
              const active = this.app.workspace.getActiveFile();
              const { link } = this.plugin.vaultService.generateAttachmentLink(
                attachment.path,
                active?.extension === "md" ? active.path : "",
              );
              await navigator.clipboard.writeText(link);
              new Notice("Attachment link copied.");
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : String(error),
              );
            }
          })();
        });
      }
      const remove = chip?.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": `Remove ${attachment.name}` },
      });
      if (remove) {
        setIcon(remove, "x");
        remove.addEventListener("click", () => {
          this.attachments.splice(index, 1);
          this.renderAttachments();
        });
      }
    });
  }

  private updateSendButton(running: boolean): void {
    if (!this.sendButton) return;
    this.sendButton.empty();
    setIcon(this.sendButton, running ? "square" : "send");
    this.sendButton.setAttribute(
      "aria-label",
      running ? "Stop response" : "Send message",
    );
    this.sendButton.onclick = running
      ? () => this.abortController?.abort()
      : () => void this.send();
  }

  private newChat(): void {
    this.abortController?.abort();
    this.plugin.runtime?.resetConversation();
    this.messages = [];
    this.attachments = [];
    this.renderShell();
    this.focusInput();
  }

  private scrollToBottom(): void {
    if (this.messageList) {
      this.messageList.scrollTop = this.messageList.scrollHeight;
    }
  }
}
