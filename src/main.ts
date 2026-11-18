import { MarkdownView, Notice, Plugin } from "obsidian";
import { buildHealthUrl, buildRoomUrl, ConnectionStatus, LiveEditConnection } from "./connection";
import { createLiveEditExtension, ActiveSession } from "./editor-binding";
import { FileSync } from "./file-sync";
import { ParticipantsModal, ParticipantsView, PARTICIPANTS_VIEW, StatusBarWidget } from "./presence";
import { DEFAULT_SETTINGS, LiveEditSettings, LiveEditSettingTab, validDisplayName } from "./settings";
import { inSharedFolder } from "./shared-scope";
import { VaultGuard } from "./vault-guard";

export default class LiveEditPlugin extends Plugin {
  settings!: LiveEditSettings;

  private connection: LiveEditConnection | null = null;
  private fileSync: FileSync | null = null;
  // Stable object reference for the lifetime of one connect() call — editor-binding.ts
  // compares this by identity to decide whether to rebind, so it must NOT be a fresh
  // object literal on every getSession() call (that caused a full yCollab
  // rebind on every keystroke, which is what was causing the lag).
  private session: ActiveSession | null = null;
  // True only once fileSync.start() has fully finished seeding/pulling the
  // room. Editors must not bind (and possibly create) a shared Y.Text before
  // this — otherwise a file opened right as we connect can race the initial
  // sync and end up bound to an orphaned Y.Text that the room's map never
  // ends up pointing at (looks like "cursors sync, text doesn't").
  private ready = false;
  // Once true, status flips (disconnect/reconnect) trigger user-facing
  // notices. Stays false during the very first connect() so we don't warn
  // about "disconnected" while just starting up.
  private hasBeenReady = false;
  private statusBar!: StatusBarWidget;
  private unsubscribeStatus: (() => void) | null = null;
  private awarenessChangeHandler: (() => void) | null = null;
  private readonly connectionListeners = new Set<() => void>();
  private unsubscribeRoom: (() => void) | null = null;
  private activityTimer: number | null = null;
  private pendingActivity: { path: string | null; line: number | null; editingUntil: number } | null = null;
  private reconnecting = false;
  private pendingDrafts = new Map<string, string>();
  private vaultGuard: VaultGuard | null = null;
  private importLegacyScope = false;
  private connectionMessage = "";

  getConnectionMessage(): string { return this.connectionMessage; }

  getConnectionStatus(): ConnectionStatus {
    const status = this.connection?.status ?? "disconnected";
    return status === "connected" && !this.ready ? "syncing" : status;
  }
  canEditShared(): boolean { return this.ready && this.connection?.status === "connected"; }
  isReadOnlyPath(path: string): boolean {
    return inSharedFolder(path, "") && !this.canEditShared();
  }
  private installVaultGuard(): void {
    if (!this.vaultGuard) this.vaultGuard = new VaultGuard(this.app.vault, () => "", () => this.canEditShared());
  }
  onConnectionChange(callback: () => void): () => void {
    this.connectionListeners.add(callback);
    return () => this.connectionListeners.delete(callback);
  }
  private notifyConnection(): void { for (const listener of this.connectionListeners) listener(); }

  private async suspendSession(): Promise<Map<string, string>> {
    this.ready = false;
    const drafts = this.fileSync?.snapshot() ?? new Map<string, string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && this.fileSync?.isTracked(leaf.view.file.path)) {
        drafts.set(leaf.view.file.path, leaf.view.editor.getValue());
      }
    }
    const sync = this.fileSync;
    this.session = null;
    this.fileSync = null;
    sync?.destroy();
    this.nudgeOpenEditors();
    await Promise.resolve();
    await sync?.settled();
    return drafts;
  }

  async reconnect(): Promise<void> {
    if (!this.requireName() || this.reconnecting) return;
    this.reconnecting = true;
    try {
      if (this.settings.role === "host" && this.connection) {
        this.connection.disconnect();
        this.connection.connect();
        await this.connection.waitUntilSynced();
        return;
      }
      const drafts = await this.suspendSession();
      for (const [path, content] of drafts) this.pendingDrafts.set(path, content);
      this.disconnect();
      await this.connect();
    } catch (error) {
      new Notice(`LiveEdit: 재접속을 완료하지 못했습니다. ${String(error)}`, 10000);
    } finally { this.reconnecting = false; }
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.installVaultGuard();

    const statusBarEl = this.addStatusBarItem();
    statusBarEl.style.cursor = "pointer";
    this.statusBar = new StatusBarWidget(statusBarEl);
    this.statusBar.render("disconnected", 0, this.settings.role);
    this.registerDomEvent(statusBarEl, "click", () => this.showParticipants());

    this.addSettingTab(new LiveEditSettingTab(this.app, this));
    this.registerView(PARTICIPANTS_VIEW, (leaf) => new ParticipantsView(leaf, this));
    this.addRibbonIcon("users", "LiveEdit 참여 위치", () => { void this.showParticipantsSidebar(); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateActiveNote()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateActiveNote()));
    this.registerEvent(this.app.vault.on("rename", () => this.updateActiveNote()));
    this.registerEvent(this.app.vault.on("delete", () => this.updateActiveNote()));

    this.registerEditorExtension(
      createLiveEditExtension({
        getSession: () => this.getSession(),
        onActivity: (path, line, editing) => this.publishActivity(path, line, editing),
        isReadOnlyPath: (path) => this.isReadOnlyPath(path),
        onAccessChange: (callback) => this.onConnectionChange(callback),
      }),
    );

    this.addCommand({
      id: "connect",
      name: "세션 연결",
      callback: () => this.connect(),
    });
    this.addCommand({
      id: "reconnect",
      name: "세션 재접속",
      callback: () => this.reconnect(),
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
    this.addCommand({
      id: "check-server",
      name: "서버 상태 확인 (방장용)",
      callback: () => this.checkServerHealth(),
    });

    if (this.settings.autoReconnect && this.settings.role === "member" && validDisplayName(this.settings.displayName)) {
      // Connect on startup if the user was previously using auto-reconnect.
      this.connect();
    }
  }

  onunload(): void {
    this.disconnect();
    this.vaultGuard?.destroy();
    this.vaultGuard = null;
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  private getSession(): ActiveSession | null {
    if (!this.canEditShared()) return null;
    return this.session;
  }

  private requireName(): boolean {
    if (validDisplayName(this.settings.displayName)) return true;
    this.connectionMessage = "이름을 먼저 입력해주세요 (1~40자).";
    this.notifyConnection();
    new Notice(`LiveEdit: ${this.connectionMessage}`);
    return false;
  }

  async connect(): Promise<void> {
    if (!this.requireName()) return;
    this.installVaultGuard();
    if (this.connection) {
      if (this.connection.status === "disconnected") { await this.reconnect(); return; }
      new Notice("LiveEdit: 이미 연결되어 있습니다.");
      return;
    }

    let url: string;
    try {
      url = buildRoomUrl(this.settings.serverUrl, this.settings.room?.trim() || DEFAULT_SETTINGS.room);
      const parsed = new URL(url);
      parsed.searchParams.delete("hostToken");
      parsed.searchParams.delete("role");
      if (this.settings.role === "host") {
        parsed.searchParams.set("role", "host");
        if (this.settings.hostToken?.trim()) parsed.searchParams.set("hostToken", this.settings.hostToken.trim());
      }
      url = parsed.toString();
    } catch {
      new Notice("LiveEdit: 서버 주소가 올바르지 않습니다. 설정을 확인해주세요.");
      return;
    }

    const isHost = this.settings.role === "host";
    this.connectionMessage = "";
    const connection = new LiveEditConnection(url, this.settings.autoReconnect, !isHost);
    connection.awareness.setLocalStateField("user", {
      name: this.settings.displayName.trim() || "익명",
      color: this.settings.color,
    });

    const sharedFolder = "";
    this.connection = connection;
    let initialization: Promise<void> = Promise.resolve();

    const refreshStatusBar = (): void => {
      const remoteCount = (connection.roomState?.peers.length ?? connection.awareness.getStates().size) - 1;
      this.statusBar.render(this.getConnectionStatus(), Math.max(0, remoteCount), this.settings.role);
      this.notifyConnection();
    };

    connection.beforeReset = async () => {
      for (const [path, content] of await this.suspendSession()) this.pendingDrafts.set(path, content);
      if (this.awarenessChangeHandler) connection.awareness.off("change", this.awarenessChangeHandler);
    };

    const initialize = async (): Promise<void> => {
      if (this.connection !== connection) return;
      if (connection.roomState?.protocol !== 2) throw new Error("릴레이 서버를 0.5.0 이상으로 업데이트해주세요.");
      if (connection.roomState.presence !== 1) throw new Error("참여 위치 기능을 사용하려면 서버도 0.7.0으로 교체해주세요.");
      if (connection.roomState.lifecycle !== 1) throw new Error("방 개설 기능을 사용하려면 서버도 0.6.0으로 교체해주세요.");
      if (isHost && !connection.roomState.host) throw new Error("서버를 실행한 PC에서 방 개설하기를 눌러주세요.");
      if (isHost && this.session && this.fileSync) {
        await Promise.resolve();
        await this.fileSync.resynchronize();
        if (this.connection !== connection || connection.status !== "connected") return;
        this.ready = true;
        this.nudgeOpenEditors();
        refreshStatusBar();
        return;
      }
      connection.awareness.off("change", refreshStatusBar);
      connection.awareness.on("change", refreshStatusBar);
      const sync = new FileSync(this.app, connection.doc, () => sharedFolder, isHost, this.pendingDrafts,
        () => this.canEditShared(), this.vaultGuard!.internalVault);
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.file && sync.isTracked(leaf.view.file.path)) {
          this.pendingDrafts.set(leaf.view.file.path, leaf.view.editor.getValue());
        }
      }
      this.fileSync = sync;
      await sync.start();
      if (isHost && this.importLegacyScope) await sync.importLocalNotes();
      await sync.settled(true);
      if (this.connection !== connection || connection.status !== "connected" || this.fileSync !== sync) {
        sync.destroy();
        return;
      }
      this.pendingDrafts = new Map();
      if (this.importLegacyScope) {
        this.importLegacyScope = false;
        this.settings.sharedFolder = "";
        await this.saveData(this.settings);
        await sync.settled(true);
        if (this.connection !== connection || connection.status !== "connected" || this.fileSync !== sync) return;
      }
      this.session = { awareness: connection.awareness, fileSync: sync };
      this.ready = true;
      this.hasBeenReady = true;
      this.updateActiveNote();
      void this.showParticipantsSidebar(false);
      this.nudgeOpenEditors();
      refreshStatusBar();
    };

    const handleStatusChange = (status: ConnectionStatus): void => {
      if (status === "connected") this.connectionMessage = "";
      if (status !== "connected") {
        if (status === "disconnected") this.connectionMessage = connection.lastError;
        this.ready = false;
        this.nudgeOpenEditors();
      }
      refreshStatusBar();
      if (status === "connected") {
        initialization = initialize();
        void initialization.catch((error) => {
          if (this.connection === connection) {
            this.disconnect();
            this.connectionMessage = String(error);
            this.notifyConnection();
            new Notice(`LiveEdit: 파일 동기화에 실패했습니다. ${String(error)}`, 10000);
          }
        });
      }
      if (!this.hasBeenReady) return; // this is just the initial connect settling in, not a real drop
      if (status === "disconnected") {
        new Notice(
          `LiveEdit: ${connection.lastError} · ${isHost ? "미전송 변경을 보관합니다." : "재접속 시 로컬 사본을 보관한 뒤 공용 문서 상태를 받아옵니다."}`,
          10000,
        );
      } else if (status === "connected") {
        new Notice("LiveEdit: 다시 연결되었습니다.");
        this.nudgeOpenEditors();
      }
    };

    this.awarenessChangeHandler = refreshStatusBar;
    connection.awareness.on("change", refreshStatusBar);
    this.unsubscribeStatus = connection.onStatusChange(handleStatusChange);
    this.unsubscribeRoom = connection.onRoomStateChange(refreshStatusBar);
    refreshStatusBar();

    connection.connect();
    // Wait for the initial handshake to settle so we don't seed the shared
    // doc from a stale local copy while the room's real content is in flight.
    try {
      let warned = false;
      while (this.connection === connection) {
        try { await connection.waitUntilSynced(); break; }
        catch (error) {
          if (!connection.willReconnect || this.connection !== connection) throw error;
          if (!warned) {
            new Notice("LiveEdit: 서버 응답을 기다리며 자동 재접속 중입니다. 동기화 전에는 로컬 파일을 업로드하지 않습니다.", 8000);
            warned = true;
          }
        }
      }
      if (this.connection !== connection) return;
      await initialization;
    } catch (error) {
      if (this.connection === connection) {
        this.disconnect();
        this.connectionMessage = String(error);
        this.notifyConnection();
        new Notice(`LiveEdit: 연결을 완료하지 못했습니다. ${String(error)}`, 10000);
      }
      return;
    }
  }

  /**
   * Forces every open markdown editor to run a CM6 update cycle (via a public,
   * no-op Editor API call) so our editor-binding extension re-checks getSession()
   * right away, instead of waiting for the user's next keystroke/click.
   */
  private nudgeOpenEditors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        const pos = view.editor.getCursor();
        view.editor.setCursor(pos);
      }
    }
  }

  disconnect(): void {
    if (!this.connection) return;
    for (const [path, content] of this.fileSync?.snapshot() ?? []) this.pendingDrafts.set(path, content);
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && inSharedFolder(leaf.view.file.path, "")) {
        this.pendingDrafts.set(leaf.view.file.path, leaf.view.editor.getValue());
      }
    }
    this.ready = false;
    this.hasBeenReady = false;
    if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.pendingActivity = null;
    this.unsubscribeRoom?.();
    this.unsubscribeRoom = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.awarenessChangeHandler) {
      this.connection.awareness.off("change", this.awarenessChangeHandler);
      this.awarenessChangeHandler = null;
    }
    const connection = this.connection;
    this.session = null;
    this.nudgeOpenEditors();
    this.fileSync?.destroy();
    connection.destroy();
    this.connection = null;
    this.fileSync = null;
    this.session = null;
    this.statusBar.render("disconnected", 0, this.settings.role);
    this.notifyConnection();
  }

  async checkServerHealth(): Promise<void> {
    let url: string;
    try {
      url = buildHealthUrl(this.settings.serverUrl);
    } catch {
      new Notice("LiveEdit: 서버 주소가 올바르지 않습니다.");
      return;
    }

    new Notice(`LiveEdit: ${url} 확인 중…`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { ok: boolean; rooms: number };
      new Notice(`LiveEdit: 서버 정상 동작 중 (열린 방 ${data.rooms}개)`);
    } catch (error) {
      new Notice(
        `LiveEdit: 서버에 연결할 수 없습니다. 릴레이 서버(node dist/server.js)가 켜져 있는지 확인하세요.\n(${String(error)})`,
      );
    }
  }

  getPresenceConnection(): LiveEditConnection | null { return this.connection; }

  showParticipants(): void { new ParticipantsModal(this.app, this).open(); }

  async showParticipantsSidebar(reveal = true): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(PARTICIPANTS_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false)!;
      if (!leaf) return;
      await leaf.setViewState({ type: PARTICIPANTS_VIEW, active: reveal });
    }
    if (reveal) await this.app.workspace.revealLeaf(leaf);
  }

  private updateActiveNote(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const path = view?.file?.path ?? this.app.workspace.getActiveFile()?.path ?? null;
    this.publishActivity(path, view ? view.editor.getCursor().line + 1 : null, false);
  }

  private publishActivity(path: string | null, line: number | null, editing: boolean): void {
    if (!this.connection || this.connection.status !== "connected") return;
    const validPath = path && inSharedFolder(path, "") && this.app.vault.getAbstractFileByPath(path) ? path : null;
    const local = this.connection.awareness.getLocalState();
    const previousPath = this.pendingActivity ? this.pendingActivity.path : local?.viewingFile;
    const previousUntil = this.pendingActivity ? this.pendingActivity.editingUntil : local?.editingUntil;
    this.pendingActivity = {
      path: validPath, line: validPath ? line : null,
      editingUntil: editing ? Date.now() + 4000 : previousPath === validPath ? previousUntil ?? 0 : 0,
    };
    if (this.activityTimer !== null) return;
    this.activityTimer = window.setTimeout(() => {
      this.activityTimer = null;
      const activity = this.pendingActivity;
      this.pendingActivity = null;
      if (!activity || this.connection?.status !== "connected") return;
      const state = this.connection.awareness.getLocalState();
      this.connection.awareness.setLocalState({ ...state, viewingFile: activity.path, line: activity.line, editingUntil: activity.editingUntil });
    }, 100);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.importLegacyScope = this.settings.role === "host" && !!this.settings.sharedFolder?.trim();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.notifyConnection();
    this.nudgeOpenEditors();
    if (this.connection) {
      this.connection.setAutoReconnect(this.settings.autoReconnect);

    }
  }
}
