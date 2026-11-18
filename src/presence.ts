import { App, ItemView, Modal, TFile, WorkspaceLeaf } from "obsidian";
import type { Awareness } from "y-protocols/awareness";
import type { ConnectionStatus, LiveEditConnection } from "./connection";

export const PARTICIPANTS_VIEW = "liveedit-participants";
export interface Participant {
  clientId: number;
  name: string;
  color: string;
  file: string | null;
  line: number | null;
  editing: boolean;
  self: boolean;
  host: boolean;
  peerId?: string;
}

export function getParticipants(awareness: Awareness, localClientId: number, connection?: LiveEditConnection | null): Participant[] {
  const states = awareness.getStates();
  const roster = connection?.roomState?.peers;
  const entries = roster ?? Array.from(states.keys(), (id) => ({
    id: "", clientIds: [id], name: "", color: "", host: false,
  }));
  return entries.map((peer) => {
    const clientId = peer.clientIds[0];
    const state = states.get(clientId) ?? {};
    return {
      clientId, name: peer.name || state.user?.name?.trim() || "익명",
      color: peer.color || state.user?.color || "#888888",
      file: typeof state.viewingFile === "string" ? state.viewingFile : null,
      line: Number.isSafeInteger(state.line) && state.line > 0 ? state.line : null,
      editing: state.editingUntil > Date.now(), self: clientId === localClientId,
      host: peer.host, peerId: peer.id,
    };
  }).sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
}

export interface PresenceSource {
  getPresenceConnection(): LiveEditConnection | null;
  getConnectionStatus(): ConnectionStatus;
  onConnectionChange(callback: () => void): () => void;
}

function renderParticipants(app: App, el: HTMLElement, source: PresenceSource): void {
  el.empty();
  const connection = source.getPresenceConnection();
  const online = connection?.status === "connected";
  el.createEl("h3", { text: "LiveEdit 참여자" });
  if (!connection || !online) {
    el.createEl("p", { text: "연결되어 있지 않습니다. 접속하면 참여 위치가 표시됩니다." });
    return;
  }
  if (source.getConnectionStatus() === "syncing") el.createEl("p", { text: "최신 노트 받는 중…" });
  const state = connection.roomState;
  if (state?.host) {
    const button = el.createEl("button", { text: state.locked ? "신규 입장 허용" : "신규 입장 잠금" });
    button.onclick = () => connection.control("lock", !state.locked);
  }
  const participants = getParticipants(connection.awareness, connection.doc.clientID, connection);
  el.createEl("p", { text: `총 ${participants.length}명 · 본인 포함`, cls: "liveedit-participant-file" });
  const list = el.createDiv({ cls: "liveedit-participant-list" });
  for (const participant of participants) {
    const row = list.createDiv({ cls: "liveedit-participant" });
    const dot = row.createSpan({ cls: "liveedit-color-dot" });
    dot.style.backgroundColor = participant.color;
    row.createSpan({ text: participant.name + (participant.self ? " (나)" : "") + (participant.host ? " · 방장" : "") });
    const detail = row.createDiv({ cls: "liveedit-participant-location" });
    if (participant.file) {
      const file = participant.file;
      const button = detail.createEl("button", { text: file, cls: "liveedit-note-link" });
      button.onclick = () => {
        const note = app.vault.getAbstractFileByPath(file);
        if (note instanceof TFile) void app.workspace.getLeaf(false).openFile(note, {
          eState: participant.line ? { line: participant.line - 1 } : undefined,
        });
      };
      detail.createSpan({ text: ` · ${participant.line ? `${participant.line}행 · ` : ""}${participant.editing ? "작성 중" : "보고 있음"}` });
    } else detail.setText("노트를 선택하지 않음");
    if (state?.host && !participant.host && participant.peerId) {
      const kick = row.createEl("button", { text: "퇴장" });
      kick.onclick = () => connection.control("kick", participant.peerId!);
    }
  }
}

/** Ignore cursor-only packets and unchanged timer ticks to preserve the panel's focus. */
function participantRenderer(app: App, el: HTMLElement, source: PresenceSource): () => void {
  let previous = "";
  return () => {
    const connection = source.getPresenceConnection();
    const signature = JSON.stringify([
      source.getConnectionStatus(), connection?.roomState?.host, connection?.roomState?.locked,
      connection?.status === "connected" ? getParticipants(connection.awareness, connection.doc.clientID, connection) : null,
    ]);
    if (signature === previous) return;
    previous = signature;
    renderParticipants(app, el, source);
  };
}

export class ParticipantsModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private timer: number | null = null;
  constructor(app: App, private readonly source: PresenceSource) { super(app); }
  onOpen(): void {
    const render = participantRenderer(this.app, this.contentEl, this.source);
    render();
    this.unsubscribe = this.source.onConnectionChange(render);
    this.timer = window.setInterval(render, 2000);
  }
  onClose(): void {
    this.unsubscribe?.();
    if (this.timer !== null) window.clearInterval(this.timer);
    this.contentEl.empty();
  }
}

export class ParticipantsView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private timer: number | null = null;
  constructor(leaf: WorkspaceLeaf, private readonly source: PresenceSource) { super(leaf); }
  getViewType(): string { return PARTICIPANTS_VIEW; }
  getDisplayText(): string { return "LiveEdit 참여자"; }
  getIcon(): string { return "users"; }
  async onOpen(): Promise<void> {
    const render = participantRenderer(this.app, this.contentEl, this.source);
    render();
    this.unsubscribe = this.source.onConnectionChange(render);
    this.timer = window.setInterval(render, 2000);
  }
  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.timer !== null) window.clearInterval(this.timer);
  }
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "연결 중…",
  syncing: "최신 문서 받는 중 · 볼트 읽기 전용",
  connected: "연결됨",
  disconnected: "연결 안 됨 · 볼트 읽기 전용",
};

const STATUS_ICON: Record<ConnectionStatus, string> = {
  connecting: "🟡",
  syncing: "🟡",
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
