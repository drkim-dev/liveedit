import { Notice, TFile, type Vault } from "obsidian";
import * as Y from "yjs";

export interface BlobTransport {
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array>;
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buffer(bytes));
  return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("");
}
type Entry = { id: string; hash: string };

/** Keeps only image references in Yjs; binary files live on the relay. */
export class BlobImageSync {
  private readonly refs: Y.Map<string>;
  private readonly paths: Y.Map<string>;
  private known = new Map<string, Entry>();
  private readonly writing = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly versions = new Map<string, number>();
  private sequence = 0;
  private destroyed = false;
  private observing = false;

  constructor(private readonly doc: Y.Doc, private readonly vault: Vault, private readonly transport: BlobTransport,
    private readonly tracked: (path: string) => boolean, private readonly canPublish: () => boolean,
    private readonly ensureParent: (path: string) => Promise<void>, private readonly recordParents: (path: string) => void,
    private readonly enqueue: (operation: () => Promise<void>, strict?: boolean) => Promise<void>,
    private readonly afterStructure: () => void, private readonly backupRoot: string) {
    this.refs = doc.getMap<string>("imageRefs");
    this.paths = doc.getMap<string>("imagePaths");
  }

  isImage(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path) && this.tracked(path + ".md");
  }
  private entries(): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    for (const [id, hash] of Array.from(this.refs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const path = this.paths.get(id);
      if (typeof path === "string" && this.isImage(path) && /^[a-f0-9]{64}$/.test(hash)) entries.set(path, { id, hash });
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
    const path = file.path;
    const version = (this.versions.get(path) ?? 0) + 1;
    this.versions.set(path, version);
    const job = this.publishFile(file, seed, version);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job)).catch(() => {});
    return job;
  }
  private async publishFile(file: TFile, seed: boolean, version: number): Promise<void> {
    if (this.destroyed || !this.isImage(file.path) || this.writing.has(file.path) || (!seed && !this.canPublish())) return;
    const path = file.path, previous = this.entries().get(path);
    const bytes = new Uint8Array(await this.vault.readBinary(file));
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`사진 한 장은 20MB까지 공유할 수 있습니다: ${path}`);
    const hash = await digest(bytes);
    if (this.destroyed || this.versions.get(path) !== version || (!seed && !this.canPublish()) || file.path !== path || this.vault.getAbstractFileByPath(path) !== file) return;
    const current = this.entries().get(path);
    if (current?.hash === hash) return;
    if (current?.hash !== previous?.hash || current?.id !== previous?.id) {
      await this.enqueue(async () => { await this.backup(path, bytes); await this.write(path); });
      return;
    }
    await this.transport.putBlob(hash, bytes);
    if (this.destroyed || this.versions.get(path) !== version || (!seed && !this.canPublish()) || file.path !== path || this.vault.getAbstractFileByPath(path) !== file) return;
    const latest = this.entries().get(path);
    if (latest?.hash !== previous?.hash || latest?.id !== previous?.id) {
      await this.enqueue(async () => { await this.backup(path, bytes); await this.write(path); });
      return;
    }
    this.doc.transact(() => {
      const id = current?.id ?? (this.refs.has(path) ? `${this.doc.clientID}:${Date.now()}:${++this.sequence}` : path);
      if (!current) this.recordParents(path);
      this.refs.set(id, hash);
      if (!current) this.paths.set(id, path);
    }, this);
  }
  delete(path: string): void {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
    if (this.writing.has(path)) return;
    this.doc.transact(() => {
      for (const [id] of this.refs) if (this.paths.get(id) === path) { this.refs.delete(id); this.paths.delete(id); }
    }, this);
  }
  deleteFolder(folder: string): void { for (const path of this.entries().keys()) if (path.startsWith(folder + "/")) this.delete(path); }
  rename(oldPath: string, newPath: string, folder = false): void {
    this.versions.set(oldPath, (this.versions.get(oldPath) ?? 0) + 1);
    if (this.writing.has(oldPath)) return;
    this.doc.transact(() => {
      for (const [id] of Array.from(this.refs)) {
        const path = this.paths.get(id);
        if (typeof path !== "string" || (path !== oldPath && !(folder && path.startsWith(oldPath + "/")))) continue;
        const destination = newPath + path.slice(oldPath.length);
        if (this.isImage(destination)) { this.paths.set(id, destination); this.recordParents(destination); }
        else { this.refs.delete(id); this.paths.delete(id); }
      }
    }, this);
  }
  private readonly onTransaction = (transaction: Y.Transaction): void => {
    const changed = new Set<unknown>(transaction.changed.keys());
    if (!changed.has(this.refs) && !changed.has(this.paths)) return;
    const previous = this.known, current = this.entries();
    this.known = current;
    if (transaction.origin !== this) {
      for (const [path] of previous) if (!current.has(path)) void this.enqueue(() => this.remove(path));
      for (const [path, entry] of current) if (previous.get(path)?.hash !== entry.hash || previous.get(path)?.id !== entry.id)
        void this.enqueue(() => this.write(path));
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
        if (this.entries().get(path)?.hash !== entry.hash) { void this.enqueue(() => this.write(path)); return; }
        if (await digest(local) === entry.hash) return;
        const remote = await this.transport.getBlob(entry.hash);
        if (await digest(remote) !== entry.hash) throw new Error("사진 데이터 검증 실패");
        await this.backup(path, local);
        if (this.destroyed) return;
        if (this.entries().get(path)?.hash !== entry.hash) { void this.enqueue(() => this.write(path)); return; }
        await this.vault.modifyBinary(existing, buffer(remote));
      } else {
        const remote = await this.transport.getBlob(entry.hash);
        if (await digest(remote) !== entry.hash) throw new Error("사진 데이터 검증 실패");
        await this.ensureParent(path);
        if (this.destroyed || this.entries().get(path)?.hash !== entry.hash) return;
        await this.vault.createBinary(path, buffer(remote));
      }
      if (!this.entries().has(path)) await this.remove(path);
      else if (this.entries().get(path)?.hash !== entry.hash) void this.enqueue(() => this.write(path));
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
  async restoreUnder(folder: string): Promise<void> { for (const path of this.entries().keys()) if (path.startsWith(folder + "/")) await this.write(path); }
  report(error: unknown): void { new Notice(`LiveEdit: 사진을 공유하지 못했습니다. ${String(error)}`, 10000); }
  destroy(): void { this.destroyed = true; if (this.observing) this.doc.off("afterTransaction", this.onTransaction); }
}
