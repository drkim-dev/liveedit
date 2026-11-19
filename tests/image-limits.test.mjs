import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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


test("small edits with photos use a recoverable journal instead of rewriting the image snapshot", async () => {
  const { Room } = await import("../server/dist/room.js");
  const dir = mkdtempSync(join(tmpdir(), "liveedit-image-journal-"));
  let room = new Room("photos", () => {}, dir);
  try {
    const photo = new Uint8Array(17 * 1024 * 1024); photo[photo.length - 1] = 77;
    room.doc.transact(() => {
      room.doc.getMap("images").set("photo.png", photo);
      room.doc.getMap("imagePaths").set("photo.png", "photo.png");
    });
    room.flush();
    const snapshot = join(dir, readdirSync(dir).find((name) => name.endsWith(".yjs")));
    const before = statSync(snapshot).size;
    room.doc.getMap("test").set("note", "small edit"); room.flush();
    assert.equal(statSync(snapshot).size, before);
    assert.ok(statSync(snapshot + ".journal").size < 4096);
    room.destroy();
    appendFileSync(snapshot + ".journal", Buffer.from([0,0]));
    room = new Room("photos", () => {}, dir);
    assert.equal(room.doc.getMap("test").get("note"), "small edit");
    assert.equal(room.doc.getMap("images").get("photo.png").at(-1), 77);
    room.doc.getMap("test").set("note", "after recovery"); room.flush(); room.destroy();
    room = new Room("photos", () => {}, dir);
    assert.equal(room.doc.getMap("test").get("note"), "after recovery");
  } finally { room.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
