import { App, Modal } from "obsidian";
import type { Awareness } from "y-protocols/awareness";
import type { ConnectionStatus } from "./connection";

export interface Participant {
  clientId: number;
  name: string;
  color: string;
  file: string | null;
}

export function getParticipants(awareness: Awareness, localClientId: number): Participant[] {
  const result: Participant[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const user = (state as { user?: { name?: string; color?: string } }).user ?? {};
    const file = (state as { viewingFile?: string }).viewingFile ?? null;
    result.push({
      clientId,
      name: user.name?.trim() || "익명",
      color: user.color || "#888888",
      file,
    });
  });
  return result;
}

export class ParticipantsModal extends Modal {
  constructor(
    app: App,
    private readonly awareness: Awareness | null,
    private readonly localClientId: number | null,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "참여자" });

    if (!this.awareness || this.localClientId === null) {
      contentEl.createEl("p", { text: "연결되어 있지 않습니다." });
      return;
    }

    const participants = getParticipants(this.awareness, this.localClientId);
    if (participants.length === 0) {
      contentEl.createEl("p", { text: "아직 다른 참여자가 없습니다." });
      return;
    }

    const list = contentEl.createDiv({ cls: "liveedit-participant-list" });
    for (const participant of participants) {
      const row = list.createDiv({ cls: "liveedit-participant" });
      const dot = row.createSpan({ cls: "liveedit-color-dot" });
      dot.style.backgroundColor = participant.color;
      row.createSpan({ text: participant.name });
      if (participant.file) {
        row.createSpan({ cls: "liveedit-participant-file", text: participant.file });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "연결 중…",
  connected: "연결됨",
  disconnected: "연결 안 됨",
};

const STATUS_ICON: Record<ConnectionStatus, string> = {
  connecting: "🟡",
  connected: "🟢",
  disconnected: "⚪",
};

export class StatusBarWidget {
  constructor(private readonly el: HTMLElement) {
    this.el.addClass("liveedit-status");
    this.render("disconnected", 0, "member");
  }

  render(status: ConnectionStatus, remoteCount: number, role: "host" | "member"): void {
    const roleTag = role === "host" ? "방장" : "참여자";
    this.el.setText(
      status === "connected"
        ? `${STATUS_ICON[status]} LiveEdit(${roleTag}) · ${remoteCount + 1}명`
        : `${STATUS_ICON[status]} LiveEdit(${roleTag}) ${STATUS_LABEL[status]}`,
    );
  }
}
