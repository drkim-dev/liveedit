import { App, Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import * as Y from "yjs";

const FILES_KEY = "files";
const WRITE_DEBOUNCE_MS = 400;

/**
 * Mirrors a Y.Map<path, Y.Text> onto the local vault (markdown files only).
 * Files currently open in a bound editor are left to editor-binding.ts,
 * which applies keystrokes to the Y.Text directly — this class only
 * writes to disk for files nobody has open locally.
 */
export class FileSync {
  private readonly files: Y.Map<Y.Text>;
  private readonly paths: Y.Map<string>;
  private knownEntries = new Map<string, Y.Text>();
  private knownContent = new Map<string, string>();
  private readonly debounceTimers = new Map<string, number>();
  private readonly openPaths = new Map<string, number>();
  private diskQueue: Promise<void> = Promise.resolve();
  private readonly writingRemotely = new Set<string>();
  private destroyed = false;
  private observing = false;
  private readonly backupRoot: string;
  private backupSequence = 0;
  private readonly structureListeners = new Set<() => void>();
  private diskError: unknown = null;

  constructor(
    private readonly app: App,
    doc: Y.Doc,
    private readonly getSharedFolder: () => string,
    private readonly canSeed = true,
    private readonly drafts = new Map<string, string>(),
    private readonly canPublish: () => boolean = () => true,
    private readonly vault: App["vault"] = app.vault,
  ) {
    this.files = doc.getMap<Y.Text>(FILES_KEY);
    this.paths = doc.getMap<string>("filePaths");
    this.backupRoot = `.liveedit-backups/${Date.now()}-${doc.clientID}`;
  }

  isTracked(path: string): boolean {
    if (typeof path !== "string") return false;
    if (!path || path.includes("\\") || /[\x00-\x1f:*?"<>|]/.test(path)) return false;
    if (path.split("/").some((part) => !part || part.startsWith(".") || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) return false;
    if (!path.endsWith(".md")) return false;
    if (path.startsWith(".obsidian/")) return false;
    const folder = this.getSharedFolder();
    if (!folder) return true;
    return path === folder || path.startsWith(`${folder}/`);
  }

  /** Whether `path` already has shared content — i.e. someone already opened/synced it. */
  hasText(path: string): boolean {
    return this.entry(path) !== undefined;
  }

  private entries(): Map<string, Y.Text> {
    const result = new Map<string, Y.Text>();
    for (const [id, text] of Array.from(this.files.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const path = this.paths.get(id) ?? id;
      if (typeof path === "string" && text instanceof Y.Text) result.set(path, text);
    }
    return result;
  }

  private entry(path: string): [string, Y.Text] | undefined {
    return Array.from(this.files.entries()).sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0)
      .find(([id, text]) => (this.paths.get(id) ?? id) === path && text instanceof Y.Text);
  }

  snapshot(): Map<string, string> {
    return new Map(Array.from(this.entries(), ([path, text]) => [path, text.toString()]));
  }

  async settled(strict = false): Promise<void> {
    for (;;) {
      for (const [path, timer] of this.debounceTimers) {
        window.clearTimeout(timer);
        this.debounceTimers.delete(path);
        void this.enqueueDisk(() => this.writeRemoteToVault(path));
      }
      const queue = this.diskQueue;
      await queue;
      if (queue === this.diskQueue && this.debounceTimers.size === 0) break;
    }
    if (strict && this.diskError) throw this.diskError;
  }

  async resynchronize(): Promise<void> {
    await this.pullAllFromRemote();
    await this.settled(true);
  }

  private addText(path: string, content: string): Y.Text {
    const id = this.files.has(path) ? `${this.files.doc!.clientID}:${Date.now()}:${++this.backupSequence}` : path;
    const text = new Y.Text(content);
    this.files.set(id, text);
    this.paths.set(id, path);
    return text;
  }

  onStructureChange(callback: () => void): () => void {
    this.structureListeners.add(callback);
    return () => this.structureListeners.delete(callback);
  }

  getOrCreateText(path: string): Y.Text {
    let text = this.entry(path)?.[1];
    if (!text) {
      this.files.doc?.transact(() => { text = this.addText(path, ""); }, this);
    }
    return text!;
  }

  markOpen(path: string): void {
    this.openPaths.set(path, (this.openPaths.get(path) ?? 0) + 1);
  }

  markClosed(path: string): void {
    const count = this.openPaths.get(path) ?? 0;
    if (count > 1) this.openPaths.set(path, count - 1);
    else {
      this.openPaths.delete(path);
      if (!this.destroyed && this.hasText(path)) this.scheduleWrite(path);
    }
  }

  async start(): Promise<void> {
    if (this.destroyed) return;
    this.knownEntries = this.entries();
    this.knownContent = this.snapshot();
    this.files.doc!.on("afterTransaction", this.handleTransaction);
    this.observing = true;
    const initialized = this.files.doc?.getMap("liveedit").get("initialized") === true;
    if (!this.canSeed && this.files.size === 0 && !initialized) {
      throw new Error("방장이 새 방의 초기 문서를 올린 뒤 다시 접속해주세요. 로컬 파일은 변경하지 않았습니다.");
    }
    if (this.files.size === 0 && this.canSeed && !initialized) {
      await this.seedFromVault();
    } else {
      // A participant's local/offline state is never an upload source on join.
      if (!this.canSeed) await this.reconcileLocalOnlyFiles();
      await this.pullAllFromRemote();
    }

    if (this.destroyed) return;
    if (this.canSeed) this.files.doc?.getMap("liveedit").set("initialized", true);
    this.vault.on("create", this.handleLocalCreate);
    this.vault.on("delete", this.handleLocalDelete);
    this.vault.on("rename", this.handleLocalRename);
    this.vault.on("modify", this.handleLocalModify);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.observing) this.files.doc!.off("afterTransaction", this.handleTransaction);
    this.observing = false;
    // Vault#off has no event-specific overloads (unlike #on), so it's typed
    // generically — cast is safe, we're removing the exact handlers we added.
    this.vault.off("create", this.handleLocalCreate as (...data: unknown[]) => unknown);
    this.vault.off("delete", this.handleLocalDelete as (...data: unknown[]) => unknown);
    this.vault.off("rename", this.handleLocalRename as (...data: unknown[]) => unknown);
    this.vault.off("modify", this.handleLocalModify as (...data: unknown[]) => unknown);
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
    this.structureListeners.clear();
  }

  private async seedFromVault(): Promise<void> {
    const files = this.vault.getMarkdownFiles().filter((f) => this.isTracked(f.path));
    for (const file of files) {
      const content = await this.vault.read(file);
      if (this.destroyed) return;
      if (this.hasText(file.path)) continue;
      this.files.doc?.transact(() => this.addText(file.path, content), this);
    }
  }

  private async pullAllFromRemote(): Promise<void> {
    for (const [path, content] of this.drafts) {
      if (!this.isTracked(path) || this.entry(path)?.[1].toString() === content) continue;
      await this.backup(path, content, "draft");
    }
    for (const path of this.entries().keys()) {
      await this.enqueueDisk(() => this.writeRemoteToVault(path, true), true);
    }
  }

  private readonly handleTransaction = (transaction: Y.Transaction): void => {
    const changed = new Set<unknown>(transaction.changed.keys());
    const structure = changed.has(this.files) || changed.has(this.paths);
    const current = structure ? this.entries() : this.knownEntries;
    if (structure) {
      const previous = this.knownEntries;
      this.knownEntries = current;
      if (transaction.origin !== this) {
        for (const [path, text] of previous) {
          if (current.get(path) !== text && this.isTracked(path)) {
            const content = this.knownContent.get(path);
            if (content !== undefined) void this.enqueueDisk(() => this.backup(path, content, "replaced-or-deleted"));
          }
        }
      }
      for (const listener of this.structureListeners) listener();
      if (transaction.origin !== this) {
        for (const path of previous.keys()) if (!current.has(path)) void this.enqueueDisk(() => this.deleteLocalFile(path));
        for (const [path, text] of current) if (previous.get(path) !== text) void this.enqueueDisk(() => this.writeRemoteToVault(path));
      }
    }
    this.knownContent = new Map(Array.from(current, ([path, text]) => [path, text.toString()]));
    if (transaction.origin === this) return;
    for (const [path, text] of current) {
      if (changed.has(text) && !this.openPaths.has(path)) this.scheduleWrite(path);
    }
  };

  private async backup(path: string, content: string, kind: string): Promise<void> {
    const target = `${this.backupRoot}/${kind}-${++this.backupSequence}/${path}`;
    await this.ensureParentFolder(target);
    await this.vault.create(target, content);
  }

  private async reconcileLocalOnlyFiles(): Promise<void> {
    for (const file of this.vault.getMarkdownFiles()) {
      if (this.destroyed) return;
      if (!this.isTracked(file.path) || this.hasText(file.path)) continue;
      const content = await this.vault.read(file);
      if (this.destroyed || this.hasText(file.path)) continue;
      await this.enqueueDisk(async () => {
        if (this.destroyed || this.hasText(file.path)) return;
        await this.backup(file.path, content, "local-only");
        if (!this.destroyed && !this.hasText(file.path)) await this.vault.trash(file, true);
      }, true);
    }
  }

  private scheduleWrite(path: string): void {
    if (this.destroyed || !this.isTracked(path)) return;
    const existing = this.debounceTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(path);
      void this.enqueueDisk(() => this.writeRemoteToVault(path));
    }, WRITE_DEBOUNCE_MS);
    this.debounceTimers.set(path, timer);
  }

  private async writeRemoteToVault(path: string, backupLocal = false): Promise<void> {
    if (this.destroyed || !this.isTracked(path) || this.openPaths.has(path)) return;
    const ytext = this.entry(path)?.[1];
    if (!ytext) return;
    const content = ytext.toString();

    this.writingRemotely.add(path);
    try {
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const current = await this.vault.read(existing);
        if (this.destroyed) return;
        if (this.openPaths.has(path) || this.entry(path)?.[1] !== ytext || ytext.toString() !== content) {
          if (backupLocal && current !== content && current !== this.entry(path)?.[1].toString()) {
            await this.backup(path, current, "before-resync");
          }
          this.scheduleWrite(path);
          return;
        }
        if (current !== content) {
          if (backupLocal) {
            const backupPath = `${this.backupRoot}/${path}`;
            await this.ensureParentFolder(backupPath);
            if (this.destroyed) return;
            await this.vault.create(backupPath, current);
          }
          if (!this.destroyed) await this.vault.modify(existing, content);
        }
      } else if (!existing) {
        await this.ensureParentFolder(path);
        if (this.destroyed) return;
        await this.vault.create(path, content);
      }
    } finally {
      this.writingRemotely.delete(path);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const folderPath = path.split("/").slice(0, -1).join("/");
    if (!folderPath) return;
    const existing = this.vault.getAbstractFileByPath(folderPath);
    if (!(existing instanceof TFolder)) {
      try {
        await this.vault.createFolder(folderPath);
      } catch (error) {
        if (!(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) throw error;
      }
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    if (this.destroyed || !this.isTracked(path) || this.hasText(path)) return;
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.writingRemotely.add(path);
      try {
        await this.vault.trash(file, true);
      } finally {
        this.writingRemotely.delete(path);
      }
    }
  }

  private readonly handleLocalCreate = async (file: TAbstractFile): Promise<void> => {
    if (this.destroyed || !this.canPublish()) return;
    if (!(file instanceof TFile) || !this.isTracked(file.path)) return;
    if (this.writingRemotely.has(file.path) || this.hasText(file.path)) return;
    const content = await this.vault.read(file);
    if (this.destroyed || !this.canPublish() || this.hasText(file.path) || this.vault.getAbstractFileByPath(file.path) !== file) return;
    this.files.doc?.transact(() => this.addText(file.path, content), this);
  };

  private enqueueDisk(operation: () => Promise<void>, propagate = false): Promise<void> {
    const pending = this.diskQueue.then(operation);
    this.diskQueue = pending.catch((error) => {
      this.diskError = error;
      console.error("LiveEdit file sync failed", error);
      new Notice("LiveEdit: 파일 반영에 실패했습니다. 저장 공간·파일 권한을 확인해주세요.");
    });
    return propagate ? pending : this.diskQueue;
  }

  private readonly handleLocalDelete = (file: TAbstractFile): void => {
    if (this.destroyed || !this.canPublish()) return;
    if (file instanceof TFolder) {
      this.files.doc?.transact(() => {
        for (const [id] of this.files) {
          const path = this.paths.get(id) ?? id;
          if (path.startsWith(`${file.path}/`) && this.isTracked(path)) { this.files.delete(id); this.paths.delete(id); }
        }
      }, this);
      return;
    }
    if (!(file instanceof TFile) || !this.isTracked(file.path)) return;
    if (this.writingRemotely.has(file.path)) return;
    const entry = this.entry(file.path);
    if (entry) this.files.doc?.transact(() => { this.files.delete(entry[0]); this.paths.delete(entry[0]); }, this);
  };

  private readonly handleLocalRename = async (file: TAbstractFile, oldPath: string): Promise<void> => {
    if (this.destroyed || !this.canPublish()) return;
    if (file instanceof TFolder) {
      this.files.doc?.transact(() => {
        for (const [id] of Array.from(this.files.entries())) {
          const path = this.paths.get(id) ?? id;
          if (!path.startsWith(`${oldPath}/`) || !this.isTracked(path)) continue;
          const newPath = file.path + path.slice(oldPath.length);
          if (this.isTracked(newPath)) this.paths.set(id, newPath);
          else { this.files.delete(id); this.paths.delete(id); }
        }
      }, this);
      // A previously unshared folder may have moved into the shared scope.
      for (const child of this.vault.getMarkdownFiles()) {
        if (child.path.startsWith(`${file.path}/`)) await this.handleLocalCreate(child);
      }
      return;
    }
    if (!(file instanceof TFile) || this.writingRemotely.has(oldPath)) return;

    const entry = this.entry(oldPath);
    if (entry && this.isTracked(oldPath)) {
      this.files.doc?.transact(() => {
        if (this.isTracked(file.path)) this.paths.set(entry[0], file.path);
        else { this.files.delete(entry[0]); this.paths.delete(entry[0]); }
      }, this);
    } else if (this.isTracked(file.path)) await this.handleLocalCreate(file);
  };

  private readonly handleLocalModify = async (file: TAbstractFile): Promise<void> => {
    if (this.destroyed || !this.canPublish()) return;
    if (!(file instanceof TFile) || !this.isTracked(file.path)) return;
    if (this.writingRemotely.has(file.path) || this.openPaths.has(file.path)) return;
    const ytext = this.entry(file.path)?.[1];
    if (!ytext) return;
    const previous = ytext.toString();
    const content = await this.vault.read(file);
    if (this.destroyed || !this.canPublish() || this.writingRemotely.has(file.path) || this.openPaths.has(file.path)) return;
    if (ytext.toString() === content) return;
    if (this.entry(file.path)?.[1] !== ytext || ytext.toString() !== previous) {
      // A disk read started before the network update. Never turn that stale
      // read into a replacement of newer shared content.
      if (content !== previous) {
        await this.enqueueDisk(async () => {
          if (this.destroyed) return;
          const backup = `${this.backupRoot}/conflict-${++this.backupSequence}/${file.path}`;
          await this.ensureParentFolder(backup);
          await this.vault.create(backup, content);
          new Notice("LiveEdit: 파일 저장과 원격 수정이 겹쳐 로컬 사본을 .liveedit-backups에 보관했습니다.");
        });
      }
      this.scheduleWrite(file.path);
      return;
    }
    let start = 0;
    while (start < previous.length && start < content.length && previous[start] === content[start]) start++;
    let end = 0;
    while (end < previous.length - start && end < content.length - start && previous[previous.length - 1 - end] === content[content.length - 1 - end]) end++;
    ytext.doc?.transact(() => {
      ytext.delete(start, previous.length - start - end);
      ytext.insert(start, content.slice(start, content.length - end));
    }, this);
  };
}

