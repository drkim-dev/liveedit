import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";

/** Wire format: first varUint byte selects the message kind. */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/**
 * One room == one shared Y.Doc + one Awareness instance.
 * Peers are symmetric: there is no host, everyone merges into the same doc.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly peers = new Map<WebSocket, Set<number>>();

  constructor(readonly name: string, private readonly onEmpty: (name: string) => void) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin as WebSocket | null);
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

  /** Register a new peer and send it the current doc + presence snapshot. */
  join(ws: WebSocket): void {
    this.peers.set(ws, new Set());

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
    const ids = this.peers.get(ws);
    this.peers.delete(ws);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(ids), null);
    }
    if (this.peers.size === 0) {
      this.onEmpty(this.name);
    }
  }

  handleMessage(ws: WebSocket, data: Uint8Array): void {
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
    }
  }

  private broadcast(message: Uint8Array, origin: WebSocket | null): void {
    for (const peer of this.peers.keys()) {
      if (peer !== origin && peer.readyState === peer.OPEN) {
        peer.send(message);
      }
    }
  }
}
