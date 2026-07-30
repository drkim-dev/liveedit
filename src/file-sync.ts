import { App, TAbstractFile, TFile, TFolder } from "obsidian";
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
  private readonly debounceTimers = new Map<string, number>();
  private readonly openPaths = new Set<string>();
  private readonly writingRemotely = new Set<string>();
  private destroyed = false;

  constructor(
    private readonly app: App,
    doc: Y.Doc,
    private readonly getSharedFolder: () => string,
  ) {
    this.files = doc.getMap<Y.Text>(FILES_KEY);
  }

  isTracked(path: string): boolean {
    if (!path.endsWith(".md")) return false;
    if (path.startsWith(".obsidian/")) return false;
    const folder = this.getSharedFolder();
    if (!folder) return true;
    return path === folder || path.startsWith(`${folder}/`);
  }

  /** Whether `path` already has shared content — i.e. someone already opened/synced it. */
  hasText(path: string): boolean {
    return this.files.has(path);
  }

  getOrCreateText(path: string): Y.Text {
    let text = this.files.get(path);
    if (!text) {
      text = new Y.Text();
      this.files.set(path, text);
    }
    return text;
  }

  markOpen(path: string): void {
    this.openPaths.add(path);
  }

  markClosed(path: string): void {
    this.openPaths.delete(path);
  }

  async start(): Promise<void> {
    if (this.files.size === 0) {
      await this.seedFromVault();
    } else {
      await this.pullAllFromRemote();
    }

    this.files.observeDeep(this.handleRemoteChange);
    this.app.vault.on("create", this.handleLocalCreate);
    this.app.vault.on("delete", this.handleLocalDelete);
    this.app.vault.on("rename", this.handleLocalRename);
    this.app.vault.on("modify", this.handleLocalModify);
  }

  destroy(): void {
    this.destroyed = true;
    this.files.unobserveDeep(this.handleRemoteChange);
    // Vault#off has no event-specific overloads (unlike #on), so it's typed
    // generically — cast is safe, we're removing the exact handlers we added.
    this.app.vault.off("create", this.handleLocalCreate as (...data: unknown[]) => unknown);
    this.app.vault.off("delete", this.handleLocalDelete as (...data: unknown[]) => unknown);
    this.app.vault.off("rename", this.handleLocalRename as (...data: unknown[]) => unknown);
    this.app.vault.off("modify", this.handleLocalModify as (...data: unknown[]) => unknown);
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
  }

  private async seedFromVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.isTracked(f.path));
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const ytext = new Y.Text();
      ytext.insert(0, content);
      this.files.set(file.path, ytext);
    }
  }

  private async pullAllFromRemote(): Promise<void> {
    for (const path of Array.from(this.files.keys())) {
      await this.writeRemoteToVault(path);
    }
  }

  private readonly handleRemoteChange = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void => {
    if (transaction.origin === this) return;

    for (const event of events) {
      if (event.target === this.files) {
        for (const [path, change] of event.changes.keys) {
          if (change.action === "delete") {
            void this.deleteLocalFile(path);
          } else {
            void this.writeRemoteToVault(path);
          }
        }
      } else {
        const path = this.pathForText(event.target as Y.Text);
        if (path && !this.openPaths.has(path)) {
          this.scheduleWrite(path);
        }
      }
    }
  };

  private pathForText(ytext: Y.Text): string | null {
    for (const [path, value] of this.files.entries()) {
      if (value === ytext) return path;
    }
    return null;
  }

  private scheduleWrite(path: string): void {
    const existing = this.debounceTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(path);
      void this.writeRemoteToVault(path);
    }, WRITE_DEBOUNCE_MS);
    this.debounceTimers.set(path, timer);
  }

  private async writeRemoteToVault(path: string): Promise<void> {
    if (this.destroyed) return;
    const ytext = this.files.get(path);
    if (!ytext) return;
    const content = ytext.toString();

    this.writingRemotely.add(path);
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        if (current !== content) await this.app.vault.modify(existing, content);
      } else if (!existing) {
        await this.ensureParentFolder(path);
        await this.app.vault.create(path, content);
      }
    } finally {
      this.writingRemotely.delete(path);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const folderPath = path.split("/").slice(0, -1).join("/");
    if (!folderPath) return;
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(existing instanceof TFolder)) {
      try {
        await this.app.vault.createFolder(folderPath);
      } catch {
        // folder created concurrently — fine
      }
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.writingRemotely.add(path);
      try {
        await this.app.vault.delete(file);
      } finally {
        this.writingRemotely.delete(path);
      }
    }
  }

  private readonly handleLocalCreate = async (file: TAbstractFile): Promise<void> => {
    if (!(file instanceof TFile) || !this.isTracked(file.path)) return;
    if (this.writingRemotely.has(file.path) || this.files.has(file.path)) return;
    const content = await this.app.vault.read(file);
    const ytext = new Y.Text();
    ytext.insert(0, content);
    this.files.set(file.path, ytext);
  };

  private readonly handleLocalDelete = (file: TAbstractFile): void => {
    if (!(file instanceof TFile) || !this.isTracked(file.path)) return;
    if (this.writingRemotely.has(file.path)) return;
    this.files.delete(file.path);
  };

  private readonly handleLocalRename = async (file: TAbstractFile, oldPath: string): Promise<void> => {
    if (!(file instanceof TFile) || this.writingRemotely.has(oldPath)) return;

    if (this.isTracked(oldPath)) this.files.delete(oldPath);
    if (this.isTracked(file.path) && !this.files.has(file.path)) {
      const content = await this.app.vault.read(file);
      const ytext = new Y.Text();
      ytext.insert(0, content);
      this.files.set(file.path, ytext);
    }
  };

  private readonly handleLocalModify = async (file: TAbstractFile): Promise<void> => {
    if (!(file instanceof TFile) || !this.isTracked(file.path)) return;
    if (this.writingRemotely.has(file.path) || this.openPaths.has(file.path)) return;
    const ytext = this.files.get(file.path);
    if (!ytext) return;
    const content = await this.app.vault.read(file);
    if (ytext.toString() === content) return;
    ytext.doc?.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, content);
    }, this);
  };
}
