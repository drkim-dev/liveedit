import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const png = Uint8Array.from([137,80,78,71,0,255]);
test("relay enforces photo limits and preserves the last accepted version", async () => {
  const { Room } = await import("../server/dist/room.js");
  const dir = mkdtempSync(join(tmpdir(), "liveedit-images-"));
  const room = new Room("images", () => {}, dir);
  try {
    const images = room.doc.getMap("images");
    room.doc.transact(() => { images.set("existing.png", png); room.doc.getMap("imagePaths").set("existing.png", "existing.png"); });
    images.set("existing.png", new Uint8Array(21 * 1024 * 1024));
    assert.deepEqual(images.get("existing.png"), png);
    const photo = new Uint8Array(20 * 1024 * 1024);
    room.doc.transact(() => { for (let i = 0; i < 4; i++) { images.set(`big${i}.png`, photo); room.doc.getMap("imagePaths").set(`big${i}.png`, `big${i}.png`); } });
    assert.ok([...images.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= 64 * 1024 * 1024);
    assert.deepEqual(images.get("existing.png"), png);
  } finally { room.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
