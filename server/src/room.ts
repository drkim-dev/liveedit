import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "./blob-store.js";

/** Wire format: first varUint byte selects the message kind. */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/**
 * One room == one shared Y.Doc + one Awareness instance.
 * Document edits merge equally; authenticated hosts control admission and sessions.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly peers = new Map<WebSocket, Set<number>>();
  private readonly identities = new Map<WebSocket, { id: string; host: boolean; name: string; color: string; clientId: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private locked = false;
  private destroyed = false;
  private readonly statePath: string;
  private readonly pendingUpdates: Uint8Array[] = [];
  private readonly blobs: BlobStore;

  constructor(readonly name: string, private readonly onEmpty: (name: string) => void, dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.statePath = join(dataDir, createHash("sha256").update(name).digest("hex") + ".yjs");
    this.blobs = new BlobStore(dataDir, name);
    try {
      if (existsSync(this.statePath)) Y.applyUpdate(this.doc, readFileSync(this.statePath));
      const journalPath = this.statePath + ".journal";
      if (existsSync(journalPath)) {
        const journal = readFileSync(journalPath);
        let offset = 0;
        while (offset + 4 <= journal.length) {
          const length = journal.readUInt32BE(offset);
          if (offset + 4 + length > journal.length) break;
          Y.applyUpdate(this.doc, journal.subarray(offset + 4, offset + 4 + length));
          offset += 4 + length;
        }
        // A crash can leave an incomplete final append. Preserve every complete record.
        if (offset < journal.length) truncateSync(journalPath, offset);
      }
    } catch (error) {
      this.awareness.destroy();
      this.doc.destroy();
      throw error;
    }
    this.awareness.setLocalState(null);
    // 0.8.0 stored all image bytes inside Yjs. Move them to individual files
    // before admitting peers so reconnects receive only lightweight references.
    const legacy = this.doc.getMap<Uint8Array>("images");
    const references = this.doc.getMap<string>("imageRefs");
    const paths = this.doc.getMap<string>("imagePaths");
    if (legacy.size) {
      const journalPath = this.statePath + ".journal";
      if (existsSync(this.statePath) && !existsSync(this.statePath + ".pre-0.9.0"))
        copyFileSync(this.statePath, this.statePath + ".pre-0.9.0");
      if (existsSync(journalPath) && !existsSync(journalPath + ".pre-0.9.0"))
        copyFileSync(journalPath, journalPath + ".pre-0.9.0");
      for (const [id, bytes] of legacy) {
        if (bytes instanceof Uint8Array && paths.has(id)) {
          const hash = BlobStore.hash(bytes);
          this.blobs.put(hash, bytes);
          references.set(id, hash);
        }
      }
      this.doc.transact(() => { for (const id of Array.from(legacy.keys())) legacy.delete(id); }, "image-migration");
      writeFileSync(this.statePath + ".tmp", Y.encodeStateAsUpdate(this.doc));
      renameSync(this.statePath + ".tmp", this.statePath);
      if (existsSync(journalPath)) truncateSync(journalPath, 0);
    }
    // Never accept a reference to bytes that were not saved first.
    this.doc.on("afterTransaction", (transaction: Y.Transaction) => {
      if (!Array.from(transaction.changed.keys()).some((type) => (type as unknown) === references)) return;
      const missing = Array.from(references).filter(([id, hash]) => !paths.has(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !this.blobs.has(hash));
      if (missing.length) this.doc.transact(() => {
        for (const [id] of missing) { references.delete(id); paths.delete(id); }
      }, "missing-image");
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.pendingUpdates.push(update);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin as WebSocket | null);
      if (this.saveTimer === null) {
        this.saveTimer = setTimeout(() => {
          try { this.flush(); } catch (error) { console.error("Room save failed", error); }
        }, 300);
      }
    });

    this.awareness.on(
      "update",
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const originWs = origin as WebSocket | null;
        const known = originWs ? this.peers.get(originWs) : undefined;
        if (known) {
          for (const id of changes.added) known.add(id);
          for (const id of changes.updated) known.add(id);
          for (const id of changes.removed) known.delete(id);
        }

        const changedIds = changes.added.concat(changes.updated, changes.removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedIds),
        );
        this.broadcast(encoding.toUint8Array(encoder), originWs);
      },
    );
  }

  get size(): number {
    return this.peers.size;
  }

  private get hostPresent(): boolean { return Array.from(this.identities.values()).some((peer) => peer.host); }

  /** Register a new peer and send it the current doc + presence snapshot. */
  join(ws: WebSocket, host = false, name = "", clientId = 0): void {
    if (!host && (!this.hostPresent || this.doc.getMap("liveedit").get("initialized") !== true)) {
      ws.close(4006, "방장이 먼저 방 개설하기를 눌러야 합니다");
      return;
    }
    if (this.locked && !host) {
      ws.close(4003, "방장이 신규 입장을 잠갔습니다");
      return;
    }
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    this.peers.set(ws, new Set());
    if (Array.from(this.identities.values()).some((peer) => peer.clientId === clientId)) {
      this.peers.delete(ws);
      ws.close(4009, "접속 식별자가 중복되었습니다. 다시 접속해주세요");
      return;
    }
    const used = new Set(Array.from(this.identities.values(), (peer) => peer.color));
    this.identities.set(ws, { id: randomUUID(), host, name, clientId, color: allocateColor(used) });
    this.sendRoomState();

    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    ws.send(encoding.toUint8Array(syncEncoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
      );
      ws.send(encoding.toUint8Array(awarenessEncoder));
    }
  }

  leave(ws: WebSocket): void {
    if (this.destroyed || !this.peers.has(ws)) return;
    const wasHost = this.identities.get(ws)?.host;
    const ids = this.peers.get(ws);
    this.peers.delete(ws);
    this.identities.delete(ws);
    if (wasHost && !this.hostPresent) {
      this.locked = false;
      for (const peer of Array.from(this.peers.keys())) {
        peer.close(4007, "방장이 방을 닫았습니다. 다시 열리면 접속합니다");
        this.leave(peer);
      }
    }
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(ids), null);
    }
    if (this.peers.size === 0 && this.emptyTimer === null) {
      try { this.flush(); } catch (error) {
        console.error("Room save failed; retaining the room in memory", error);
        return;
      }
      this.emptyTimer = setTimeout(() => {
        this.destroy();
        this.onEmpty(this.name);
      }, 5 * 60 * 1000);
    }
    this.sendRoomState();
  }

  handleMessage(ws: WebSocket, data: Uint8Array): void {
    if (this.destroyed || !this.peers.has(ws)) return;
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);

    if (type === MSG_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder));
      }
    } else if (type === MSG_AWARENESS) {
      const identity = this.identities.get(ws)!;
      const payload = decoding.readVarUint8Array(decoder);
      if (payload.length > 65536) throw new Error("Presence packet too large");
      const update = decoding.createDecoder(payload);
      if (decoding.readVarUint(update) !== 1) throw new Error("One presence identity per connection required");
      const id = decoding.readVarUint(update);
      const clock = decoding.readVarUint(update);
      if (id !== identity.clientId) throw new Error("Presence identity mismatch");
      const state = JSON.parse(decoding.readVarString(update));
      if (state !== null) {
        state.user = { name: identity.name, color: identity.color };
        const file = state.viewingFile;
        state.viewingFile = typeof file === "string" && file.length <= 1024 && file.endsWith(".md") &&
          !file.split("/").some((part: string) => part.startsWith(".")) ? file : null;
        state.line = Number.isSafeInteger(state.line) && state.line > 0 ? state.line : null;
        state.editingUntil = typeof state.editingUntil === "number" ? Math.min(Date.now() + 5000, state.editingUntil) : 0;
      }
      const sanitized = encoding.createEncoder();
      encoding.writeVarUint(sanitized, 1);
      encoding.writeVarUint(sanitized, id);
      encoding.writeVarUint(sanitized, clock);
      encoding.writeVarString(sanitized, JSON.stringify(state));
      awarenessProtocol.applyAwarenessUpdate(this.awareness, encoding.toUint8Array(sanitized), ws);
    } else if (type === 2) {
      if (!this.identities.get(ws)?.host) {
        ws.close(4001, "방장 권한이 필요합니다");
        return;
      }
      const command = JSON.parse(decoding.readVarString(decoder));
      if (command.action === "lock" && typeof command.value === "boolean") {
        this.locked = command.value;
        this.sendRoomState();
      } else if (command.action === "kick" && typeof command.value === "string") {
        for (const [peer, identity] of this.identities) {
          if (identity.id === command.value && !identity.host) {
            peer.close(4004, "방장이 연결을 종료했습니다");
            this.leave(peer);
          }
        }
      }
    } else if (type === 5) {
      const hash = decoding.readVarString(decoder);
      const bytes = decoding.readVarUint8Array(decoder);
      this.blobs.put(hash, bytes);
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 8); encoding.writeVarString(reply, hash);
      ws.send(encoding.toUint8Array(reply));
    } else if (type === 6) {
      const hash = decoding.readVarString(decoder);
      const bytes = this.blobs.get(hash);
      if (!bytes) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 9); encoding.writeVarString(reply, hash);
        ws.send(encoding.toUint8Array(reply));
        return;
      }
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 7); encoding.writeVarString(reply, hash);
      encoding.writeVarUint8Array(reply, bytes);
      ws.send(encoding.toUint8Array(reply));
    }
  }

  private sendRoomState(): void {
    const peers = Array.from(this.identities, ([ws, identity]) => ({
      id: identity.id, host: identity.host, name: identity.name, color: identity.color, clientIds: [identity.clientId],
    }));
    for (const [ws, identity] of this.identities) {
      if (ws.readyState !== ws.OPEN) continue;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 2);
      encoding.writeVarString(encoder, JSON.stringify({ protocol: 3, lifecycle: 1, presence: 1, images: 2, selfId: identity.id, host: identity.host, locked: this.locked, peers }));
      ws.send(encoding.toUint8Array(encoder));
    }
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.pendingUpdates.length && existsSync(this.statePath)) return;
    const journalPath = this.statePath + ".journal";
    const journalSize = existsSync(journalPath) ? statSync(journalPath).size : 0;
    const update = this.pendingUpdates.length ? Y.mergeUpdates(this.pendingUpdates) : new Uint8Array();
    if (this.doc.getMap("imageRefs").size && existsSync(this.statePath) && journalSize + update.length + 4 < 64 * 1024 * 1024) {
      // This is a journal checkpoint threshold, not a photo storage limit.
      const frame = Buffer.allocUnsafe(update.length + 4);
      frame.writeUInt32BE(update.length, 0); frame.set(update, 4);
      try { appendFileSync(journalPath, frame); }
      catch (error) { if (existsSync(journalPath)) truncateSync(journalPath, journalSize); throw error; }
    } else {
      writeFileSync(this.statePath + ".tmp", Y.encodeStateAsUpdate(this.doc));
      renameSync(this.statePath + ".tmp", this.statePath);
      // Snapshot first: replaying an older journal is safe if a crash precedes truncation.
      if (existsSync(journalPath)) truncateSync(journalPath, 0);
    }
    this.pendingUpdates.length = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.awareness.destroy();
    this.doc.destroy();
    this.peers.clear();
    this.identities.clear();
  }

  private broadcast(message: Uint8Array, origin: WebSocket | null): void {
    for (const peer of this.peers.keys()) {
      if (peer !== origin && peer.readyState === peer.OPEN) {
        peer.send(message);
      }
    }
  }
}

/** Allocate from a distinct palette first, then unique 24-bit colors for larger rooms. */
export function allocateColor(used: Set<string>): string {
  const palette = ["#e64980", "#1971c2", "#2b8a3e", "#e67700", "#7048e8", "#099268", "#c92a2a", "#a61e4d", "#5c7cfa", "#5c940d", "#0b7285", "#862e9c"];
  for (const color of palette) if (!used.has(color)) return color;
  for (let index = 1; index <= 0xffffff; index++) {
    const color = "#" + ((index * 2654435761) & 0xffffff).toString(16).padStart(6, "0");
    if (!used.has(color)) return color;
  }
  throw new Error("No color available");
}
