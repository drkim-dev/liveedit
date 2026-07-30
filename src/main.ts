import { Notice, Plugin } from "obsidian";
import { buildRoomUrl, LiveEditConnection } from "./connection";
import { createLiveEditExtension, ActiveSession } from "./editor-binding";
import { FileSync } from "./file-sync";
import { ParticipantsModal, StatusBarWidget } from "./presence";
import { DEFAULT_SETTINGS, LiveEditSettings, LiveEditSettingTab } from "./settings";

export default class LiveEditPlugin extends Plugin {
  settings!: LiveEditSettings;

  private connection: LiveEditConnection | null = null;
  private fileSync: FileSync | null = null;
  // Stable object reference for the lifetime of one connect() call — editor-binding.ts
  // compares this by identity to decide whether to rebind, so it must NOT be a fresh
  // object literal on every getSession() call (that caused a full yCollab
  // rebind on every keystroke, which is what was causing the lag).
  private session: ActiveSession | null = null;
  private statusBar!: StatusBarWidget;
  private unsubscribeStatus: (() => void) | null = null;
  private awarenessChangeHandler: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    const statusBarEl = this.addStatusBarItem();
    statusBarEl.style.cursor = "pointer";
    this.statusBar = new StatusBarWidget(statusBarEl);
    this.registerDomEvent(statusBarEl, "click", () => this.showParticipants());

    this.addSettingTab(new LiveEditSettingTab(this.app, this));

    this.registerEditorExtension(
      createLiveEditExtension({
        getSession: () => this.getSession(),
      }),
    );

    this.addCommand({
      id: "connect",
      name: "세션 연결",
      callback: () => this.connect(),
    });
    this.addCommand({
      id: "disconnect",
      name: "세션 연결 해제",
      callback: () => this.disconnect(),
    });
    this.addCommand({
      id: "show-participants",
      name: "참여자 보기",
      callback: () => this.showParticipants(),
    });

    if (this.settings.autoReconnect) {
      // Connect on startup if the user was previously using auto-reconnect.
      this.connect();
    }
  }

  onunload(): void {
    this.disconnect();
  }

  private getSession(): ActiveSession | null {
    if (!this.connection || this.connection.status !== "connected") return null;
    return this.session;
  }

  async connect(): Promise<void> {
    if (this.connection) {
      new Notice("LiveEdit: 이미 연결되어 있습니다.");
      return;
    }
    if (!this.settings.room.trim()) {
      new Notice("LiveEdit: 방 코드를 설정에서 입력해주세요.");
      return;
    }

    let url: string;
    try {
      url = buildRoomUrl(this.settings.serverUrl, this.settings.room);
    } catch {
      new Notice("LiveEdit: 서버 주소가 올바르지 않습니다. 설정을 확인해주세요.");
      return;
    }

    const connection = new LiveEditConnection(url, this.settings.autoReconnect);
    connection.awareness.setLocalStateField("user", {
      name: this.settings.displayName.trim() || "익명",
      color: this.settings.color,
    });

    const fileSync = new FileSync(this.app, connection.doc, () => this.settings.sharedFolder);

    this.connection = connection;
    this.fileSync = fileSync;
    this.session = { awareness: connection.awareness, fileSync };

    const refreshStatusBar = (): void => {
      const remoteCount = connection.awareness.getStates().size - 1;
      this.statusBar.render(connection.status, Math.max(0, remoteCount));
    };

    this.awarenessChangeHandler = refreshStatusBar;
    connection.awareness.on("change", refreshStatusBar);
    this.unsubscribeStatus = connection.onStatusChange(refreshStatusBar);
    refreshStatusBar();

    connection.connect();
    // Wait for the initial handshake to settle so we don't seed the shared
    // doc from a stale local copy while the room's real content is in flight.
    await connection.waitUntilSynced();
    await fileSync.start();
  }

  disconnect(): void {
    if (!this.connection) return;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.awarenessChangeHandler) {
      this.connection.awareness.off("change", this.awarenessChangeHandler);
      this.awarenessChangeHandler = null;
    }
    this.connection.destroy();
    this.connection = null;
    this.fileSync?.destroy();
    this.fileSync = null;
    this.session = null;
    this.statusBar.render("disconnected", 0);
  }

  showParticipants(): void {
    new ParticipantsModal(
      this.app,
      this.connection?.awareness ?? null,
      this.connection?.doc.clientID ?? null,
    ).open();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.connection) {
      this.connection.awareness.setLocalStateField("user", {
        name: this.settings.displayName.trim() || "익명",
        color: this.settings.color,
      });
    }
  }
}
