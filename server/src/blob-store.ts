import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
export class BlobStore {
  private readonly directory: string;
  constructor(dataDir: string, room: string) {
    this.directory = join(dataDir, "images", createHash("sha256").update(room).digest("hex"));
    mkdirSync(this.directory, { recursive: true });
  }
  static hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
  private path(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid image hash");
    return join(this.directory, hash);
  }
  has(hash: string): boolean { return existsSync(this.path(hash)); }
  put(hash: string, bytes: Uint8Array): void {
    if (bytes.length > MAX_BLOB_BYTES || BlobStore.hash(bytes) !== hash) throw new Error("Invalid image data");
    const target = this.path(hash);
    if (existsSync(target)) return;
    const temporary = target + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      try { renameSync(temporary, target); }
      catch (error) { if (!existsSync(target)) throw error; }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  get(hash: string): Uint8Array | null {
    const target = this.path(hash);
    return existsSync(target) ? readFileSync(target) : null;
  }
}
