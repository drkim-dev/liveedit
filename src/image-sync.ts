import { Notice, TFile, type Vault } from "obsidian";
import * as Y from "yjs";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ROOM_IMAGE_BYTES = 64 * 1024 * 1024;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
type ImageEntry = { id: string; bytes: Uint8Array };

/** Binary data stays binary in Yjs: markdown links keep their original vault paths. */
export class ImageSync {
  private readonly images: Y.Map<Uint8Array>;
  private readonly paths: Y.Map<string>;
  private known = new Map<string, ImageEntry>();
  private readonly writing = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private sequence = 0;
  private destroyed = false;
  private observing = false;

  constructor(private readonly doc: Y.Doc, private readonly vault: Vault,
    private readonly tracked: (path: string) => boolean,
    private readonly canPublish: () => boolean,
    private readonly ensureParent: (path: string) => Promise<void>,
    private readonly recordParents: (path: string) => void,
    private readonly enqueue: (operation: () => Promise<void>, strict?: boolean) => Promise<void>,
    private readonly afterStructure: () => void,
    private readonly backupRoot: string) {
    this.images = doc.getMap<Uint8Array>("images");
    this.paths = doc.getMap<string>("imagePaths");
  }

  isImage(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path) && this.tracked(path + ".md");
  }

  private entries(): Map<string, ImageEntry> {
    const entries = new Map<string, ImageEntry>();
    for (const [id, bytes] of Array.from(this.images).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const path = this.paths.get(id);
      if (typeof path === "string" && this.isImage(path) && bytes instanceof Uint8Array && bytes.length <= MAX_IMAGE_BYTES) {
        entries.set(path, { id, bytes });
      }
    }
    return entries;
  }

  hasUnder(folder: string): boolean { return Array.from(this.entries().keys()).some((path) => path.startsWith(folder + "/")); }

  async start(host: boolean): Promise<void> {
    this.known = this.entries();
    this.doc.on("afterTransaction", this.onTransaction);
    this.observing = true;
    if (host && this.doc.getMap("liveedit").get("imagesInitialized") !== true) {
      for (const file of this.vault.getAllLoadedFiles?.() ?? []) {
        if (file instanceof TFile && this.isImage(file.path) && !this.entries().has(file.path)) {
          try { await this.publish(file, true); } catch (error) { this.report(error); }
        }
        if (this.destroyed) return;
      }
      this.doc.getMap("liveedit").set("imagesInitialized", true);
    }
    await this.pull(!host);
  }

  async pull(removeLocalOnly = false): Promise<void> {
    if (removeLocalOnly && this.doc.getMap("liveedit").get("imagesInitialized") === true) {
      for (const file of this.vault.getAllLoadedFiles?.() ?? []) {
        if (file instanceof TFile && this.isImage(file.path) && !this.entries().has(file.path)) {
          await this.enqueue(async () => {
            if (this.destroyed || this.entries().has(file.path) || this.vault.getAbstractFileByPath(file.path) !== file) return;
            await this.remove(file.path);
          }, true);
        }
      }
    }
    for (const path of this.entries().keys()) await this.enqueue(() => this.write(path), true);
  }

  async settled(): Promise<void> { while (this.pending.size) await Promise.allSettled(Array.from(this.pending)); }

  publish(file: TFile, seed = false): Promise<void> {
    const job = this.publishFile(file, seed);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job)).catch(() => {});
    return job;
  }

  private async publishFile(file: TFile, seed: boolean): Promise<void> {
    if (this.destroyed || !this.isImage(file.path) || this.writing.has(file.path) || (!seed && !this.canPublish())) return;
    const path = file.path, previous = this.entries().get(path);
    const bytes = new Uint8Array(await this.vault.readBinary(file));
    if (this.destroyed || (!seed && !this.canPublish()) || file.path !== path || this.vault.getAbstractFileByPath(path) !== file) return;
    const current = this.entries().get(path);
    if (current && sameBytes(current.bytes, bytes)) return;
    if (current?.bytes !== previous?.bytes || current?.id !== previous?.id) {
      await this.enqueue(async () => { await this.backup(path, bytes); await this.write(path); });
      return;
    }
    const total = Array.from(this.images.values()).reduce((sum, data) => sum + (data instanceof Uint8Array ? data.length : 0), 0);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`사진 한 장은 20MB까지 공유할 수 있습니다: ${path}`);
    if (total - (current?.bytes.length ?? 0) + bytes.length > MAX_ROOM_IMAGE_BYTES) throw new Error("방의 사진 공유 용량(64MB)이 가득 찼습니다.");
    this.doc.transact(() => {
      const id = current?.id ?? (this.images.has(path) ? `${this.doc.clientID}:${Date.now()}:${++this.sequence}` : path);
      if (!current) this.recordParents(path);
      this.images.set(id, bytes);
      if (!current) this.paths.set(id, path);
    }, this);
  }

  delete(path: string): void {
    if (this.writing.has(path)) return;
    this.doc.transact(() => {
      for (const [id] of this.images) if ((this.paths.get(id) ?? id) === path) { this.images.delete(id); this.paths.delete(id); }
    }, this);
  }

  deleteFolder(folder: string): void {
    for (const path of this.entries().keys()) if (path.startsWith(folder + "/")) this.delete(path);
  }

  rename(oldPath: string, newPath: string, folder = false): void {
    if (this.writing.has(oldPath)) return;
    this.doc.transact(() => {
      for (const [id] of Array.from(this.images)) {
        const path = this.paths.get(id);
        if (typeof path !== "string" || (path !== oldPath && !(folder && path.startsWith(oldPath + "/")))) continue;
        const destination = newPath + path.slice(oldPath.length);
        if (this.isImage(destination)) { this.paths.set(id, destination); this.recordParents(destination); }
        else { this.images.delete(id); this.paths.delete(id); }
      }
    }, this);
  }

  private readonly onTransaction = (transaction: Y.Transaction): void => {
    const changed = new Set<unknown>(transaction.changed.keys());
    if (!changed.has(this.images) && !changed.has(this.paths)) return;
    const previous = this.known, current = this.entries();
    this.known = current;
    if (transaction.origin !== this) {
      for (const [path] of previous) if (!current.has(path)) void this.enqueue(() => this.remove(path));
      for (const [path, entry] of current) {
        if (previous.get(path)?.bytes !== entry.bytes || previous.get(path)?.id !== entry.id) void this.enqueue(() => this.write(path));
      }
    }
    this.afterStructure();
  };

  private async backup(path: string, bytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    const target = `${this.backupRoot}/images-${++this.sequence}/${path}`;
    await this.ensureParent(target);
    if (!this.destroyed) await this.vault.createBinary(target, buffer(bytes));
  }

  private async write(path: string): Promise<void> {
    if (this.destroyed) return;
    const entry = this.entries().get(path);
    if (!entry) return;
    this.writing.add(path);
    try {
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFile)) throw new Error(`사진 경로에 폴더가 있습니다: ${path}`);
      if (existing instanceof TFile) {
        const local = new Uint8Array(await this.vault.readBinary(existing));
        if (this.destroyed) return;
        if (this.entries().get(path)?.bytes !== entry.bytes) { void this.enqueue(() => this.write(path)); return; }
        if (sameBytes(local, entry.bytes)) return;
        await this.backup(path, local);
        if (this.destroyed) return;
        if (this.entries().get(path)?.bytes !== entry.bytes) { void this.enqueue(() => this.write(path)); return; }
        await this.vault.modifyBinary(existing, buffer(entry.bytes));
      } else {
        await this.ensureParent(path);
        if (this.destroyed || this.entries().get(path)?.bytes !== entry.bytes) return;
        await this.vault.createBinary(path, buffer(entry.bytes));
      }
      if (!this.entries().has(path)) await this.remove(path);
      else if (this.entries().get(path)?.bytes !== entry.bytes) void this.enqueue(() => this.write(path));
    } finally { this.writing.delete(path); }
  }

  private async remove(path: string): Promise<void> {
    if (this.destroyed || this.entries().has(path)) return;
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    this.writing.add(path);
    try {
      const local = new Uint8Array(await this.vault.readBinary(file));
      await this.backup(path, local);
      if (!this.destroyed && !this.entries().has(path)) await this.vault.trash(file, true);
    } finally { this.writing.delete(path); }
  }

  async restoreUnder(folder: string): Promise<void> {
    for (const path of this.entries().keys()) if (path.startsWith(folder + "/")) await this.write(path);
  }

  report(error: unknown): void { new Notice(`LiveEdit: 사진을 공유하지 못했습니다. ${String(error)}`, 10000); }

  destroy(): void {
    this.destroyed = true;
    if (this.observing) this.doc.off("afterTransaction", this.onTransaction);
  }
}
