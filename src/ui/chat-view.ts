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
import type { ChatMessage, ContextAttachment, ProviderUsage } from "../types";
import type NotalithPlugin from "../main";

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
}

class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void,
    plugin: NotalithPlugin,
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose a note or image...");
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
      text: "Attach notes, selections, or images. Notalith can also search and read notes with read-only tools.",
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

    const responseActions = toolbar.createDiv({
      cls: "notalith-toolbar-group notalith-response-actions",
    });
    this.renderDeploymentSelect(responseActions);
    this.sendButton = this.iconButton(
      responseActions,
      "send",
      "Send message",
      () => void this.send(),
      "notalith-send",
    );
    this.renderAttachments();
  }

  private renderDeploymentSelect(parent: HTMLElement): void {
    const deployments = this.plugin.settings.deployments;
    const current = deployments.find(
      (deployment) =>
        deployment.deploymentName === this.plugin.settings.deploymentName,
    );
    const button = parent.createEl("button", {
      cls: "notalith-model-menu",
      attr: {
        type: "button",
        "aria-label": "Select model deployment",
        title: "Select model deployment",
      },
    });
    button.createSpan({
      cls: "notalith-model-menu-label",
      text: current?.displayName || current?.deploymentName || "Select model",
    });
    const chevron = button.createSpan({
      cls: "notalith-model-menu-chevron",
    });
    setIcon(chevron, "chevron-down");
    button.disabled = deployments.length === 0;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (this.abortController) {
        new Notice("Stop the current response before switching deployments.");
        return;
      }
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Model").setIsLabel(true));
      for (const deployment of this.plugin.settings.deployments) {
        menu.addItem((item) =>
          item
            .setTitle(deployment.displayName || deployment.deploymentName)
            .setChecked(
              deployment.deploymentName === this.plugin.settings.deploymentName,
            )
            .onClick(async () => {
              await this.plugin.selectDeployment(deployment.deploymentName);
              this.newChat();
              new Notice(`Using model: ${deployment.displayName}`);
            }),
        );
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
    if (!this.plugin.isConfigured()) {
      new Notice("Configure Azure Foundry in Notalith settings.");
      return;
    }

    const userMessage: UiChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: prompt,
      createdAt: Date.now(),
      attachments: [...this.attachments],
    };
    const assistantMessage: UiChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      toolActivities: [],
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
      await this.plugin.runtime.send(
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
        },
        this.abortController.signal,
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
    let section = messageEl.querySelector(
      ".notalith-tools",
    ) as HTMLElement | null;
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
    let el = messageEl.querySelector(".notalith-usage") as HTMLElement | null;
    if (!el) el = messageEl.createDiv({ cls: "notalith-usage" });
    el.setText(`${usage.totalTokens.toLocaleString()} tokens`);
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
    const files = [
      ...this.plugin.vaultService.listAttachableNotes(),
      ...this.plugin.vaultService.listAttachableImages(),
      ...this.plugin.vaultService.listAttachableDocuments(),
    ];
    new VaultFileSuggestModal(
      files,
      (file) => void this.attachFile(file),
      this.plugin,
    ).open();
  }

  private async attachFile(file: TFile): Promise<void> {
    try {
      const image = this.plugin.vaultService
        .listAttachableImages()
        .some((candidate) => candidate.path === file.path);
      const office = this.plugin.vaultService
        .listAttachableDocuments()
        .some((candidate) => candidate.path === file.path);
      const attachment: ContextAttachment = image
        ? {
            id: crypto.randomUUID(),
            kind: "image",
            path: file.path,
            name: file.name,
            ...(await this.plugin.vaultService.readImage(file.path)),
          }
        : office
          ? {
              id: crypto.randomUUID(),
              kind: "document",
              path: file.path,
              name: file.name,
            }
          : {
              id: crypto.randomUUID(),
              kind: "note",
              path: file.path,
              name: file.basename,
            };
      this.addAttachment(attachment);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
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
    this.plugin.runtime.resetConversation();
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
