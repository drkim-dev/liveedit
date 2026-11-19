import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as Y from "../server/node_modules/yjs/dist/yjs.mjs";

test("room stores more than 64MB of photos outside the live document", async () => {
  const { Room } = await import("../server/dist/room.js");
  const { BlobStore } = await import("../server/dist/blob-store.js");
  const dir = mkdtempSync(join(tmpdir(), "liveedit-blobs-"));
  let room = new Room("photos", () => {}, dir);
  try {
    const store = new BlobStore(dir, "photos");
    for (let index = 0; index < 4; index++) {
      const bytes = new Uint8Array(18 * 1024 * 1024); bytes[bytes.length - 1] = index + 1;
      const hash = BlobStore.hash(bytes);
      store.put(hash, bytes);
      room.doc.transact(() => {
        room.doc.getMap("imageRefs").set(`photo-${index}.png`, hash);
        room.doc.getMap("imagePaths").set(`photo-${index}.png`, `Photos/photo-${index}.png`);
      });
    }
    assert.equal(room.doc.getMap("imageRefs").size, 4);
    assert.equal(room.doc.getMap("images").size, 0);
    assert.ok(Y.encodeStateAsUpdate(room.doc).length < 4096);
    assert.throws(() => store.put(BlobStore.hash(new Uint8Array(21 * 1024 * 1024)), new Uint8Array(21 * 1024 * 1024)));
    room.flush(); room.destroy();
    room = new Room("photos", () => {}, dir);
    assert.equal(room.doc.getMap("imageRefs").size, 4);
    for (let index = 0; index < 4; index++) {
      const hash = room.doc.getMap("imageRefs").get(`photo-${index}.png`);
      assert.equal(store.get(hash).at(-1), index + 1);
    }
  } finally { room.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

test("0.8.0 photo snapshots migrate to individual relay files", async () => {
  const { Room } = await import("../server/dist/room.js");
  const { BlobStore } = await import("../server/dist/blob-store.js");
  const dir = mkdtempSync(join(tmpdir(), "liveedit-migrate-"));
  const old = new Y.Doc();
  const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255]);
  old.transact(() => { old.getMap("images").set("old.png", bytes); old.getMap("imagePaths").set("old.png", "Photos/old.png"); });
  const state = join(dir, createHash("sha256").update("team").digest("hex") + ".yjs");
  writeFileSync(state, Y.encodeStateAsUpdate(old)); old.destroy();
  let room = new Room("team", () => {}, dir);
  try {
    const hash = BlobStore.hash(bytes);
    assert.equal(room.doc.getMap("images").size, 0);
    assert.equal(room.doc.getMap("imageRefs").get("old.png"), hash);
    assert.ok(statSync(state + ".pre-0.9.0").size > 0);
    assert.deepEqual(new Uint8Array(new BlobStore(dir, "team").get(hash)), bytes);
    room.destroy(); room = new Room("team", () => {}, dir);
    assert.equal(room.doc.getMap("imageRefs").get("old.png"), hash);
    assert.equal(room.doc.getMap("images").size, 0);
  } finally { room.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

test("small edits use a recoverable journal after photo references are saved", async () => {
  const { Room } = await import("../server/dist/room.js");
  const { BlobStore } = await import("../server/dist/blob-store.js");
  const dir = mkdtempSync(join(tmpdir(), "liveedit-image-journal-"));
  let room = new Room("photos", () => {}, dir);
  try {
    const photo = new Uint8Array(17 * 1024 * 1024); photo[photo.length - 1] = 77;
    const hash = BlobStore.hash(photo);
    new BlobStore(dir, "photos").put(hash, photo);
    room.doc.transact(() => {
      room.doc.getMap("imageRefs").set("photo.png", hash);
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
    assert.equal(new BlobStore(dir, "photos").get(hash).at(-1), 77);
  } finally { room.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
