import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  private readonly identities = new Map<WebSocket, { id: string; host: boolean }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private locked = false;
  private destroyed = false;
  private readonly statePath: string;

  constructor(readonly name: string, private readonly onEmpty: (name: string) => void, dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.statePath = join(dataDir, createHash("sha256").update(name).digest("hex") + ".yjs");
    try {
      if (existsSync(this.statePath)) Y.applyUpdate(this.doc, readFileSync(this.statePath));
    } catch (error) {
      this.awareness.destroy();
      this.doc.destroy();
      throw error;
    }
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
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
        this.sendRoomState();
      },
    );
  }

  get size(): number {
    return this.peers.size;
  }

  private get hostPresent(): boolean { return Array.from(this.identities.values()).some((peer) => peer.host); }

  /** Register a new peer and send it the current doc + presence snapshot. */
  join(ws: WebSocket, host = false): void {
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
    this.identities.set(ws, { id: randomUUID(), host });
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
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
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
    }
  }

  private sendRoomState(): void {
    const peers = Array.from(this.identities, ([ws, identity]) => ({
      ...identity, clientIds: Array.from(this.peers.get(ws) ?? []),
    }));
    for (const [ws, identity] of this.identities) {
      if (ws.readyState !== ws.OPEN) continue;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 2);
      encoding.writeVarString(encoder, JSON.stringify({ protocol: 2, lifecycle: 1, host: identity.host, locked: this.locked, peers }));
      ws.send(encoding.toUint8Array(encoder));
    }
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writeFileSync(this.statePath + ".tmp", Y.encodeStateAsUpdate(this.doc));
    renameSync(this.statePath + ".tmp", this.statePath);
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
