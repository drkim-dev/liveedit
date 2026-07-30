import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const RECONNECT_DELAY_MS = 2000;
/** No new sync messages for this long after connecting == initial handshake settled. */
const SYNC_QUIET_MS = 150;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Builds the room URL, preserving any query string (e.g. a shared token) already in serverUrl. */
export function buildRoomUrl(serverUrl: string, room: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${encodeURIComponent(room)}`;
  return url.toString();
}

/**
 * Thin Yjs WebSocket peer: only the sync + awareness wire protocols, no
 * IndexedDB persistence or cross-tab sync — those aren't needed here.
 */
export class LiveEditConnection {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  status: ConnectionStatus = "disconnected";

  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private shouldReconnect = false;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  private synced = false;
  private syncSettleTimer: number | null = null;
  private readonly syncedListeners = new Set<() => void>();

  constructor(private url: string, private autoReconnect: boolean) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // update came from the network, don't echo it back
      this.sendSync(update);
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === "remote") return;
        this.sendAwareness(added.concat(updated, removed));
      },
    );
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** Resolves once the initial sync handshake has settled, or after timeoutMs, whichever first. */
  waitUntilSynced(timeoutMs = 4000): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve) => {
      const onSynced = () => {
        window.clearTimeout(timeout);
        this.syncedListeners.delete(onSynced);
        resolve();
      };
      const timeout = window.setTimeout(onSynced, timeoutMs);
      this.syncedListeners.add(onSynced);
    });
  }

  private markSyncActivity(): void {
    if (this.syncSettleTimer !== null) window.clearTimeout(this.syncSettleTimer);
    this.syncSettleTimer = window.setTimeout(() => {
      this.syncSettleTimer = null;
      this.synced = true;
      for (const listener of Array.from(this.syncedListeners)) listener();
    }, SYNC_QUIET_MS);
  }

  connect(): void {
    this.shouldReconnect = this.autoReconnect;
    this.open();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.syncSettleTimer !== null) {
      window.clearTimeout(this.syncSettleTimer);
      this.syncSettleTimer = null;
    }
    this.synced = false;
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  destroy(): void {
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private open(): void {
    this.setStatus("connecting");
    this.synced = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus("connected");
      // Kick off the mutual sync handshake: tell the server our current state vector.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      this.markSyncActivity();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleMessage(new Uint8Array(event.data));
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // stale handler from a previous socket
      this.ws = null;
      this.setStatus("disconnected");
      this.clearRemoteAwareness();
      if (this.shouldReconnect) {
        this.reconnectTimer = window.setTimeout(() => this.open(), RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => ws.close();
  }

  private clearRemoteAwareness(): void {
    const remoteIds = Array.from(this.awareness.getStates().keys()).filter(
      (id) => id !== this.doc.clientID,
    );
    if (remoteIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, remoteIds, "remote");
    }
  }

  private handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);

    if (type === MSG_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      this.markSyncActivity();
      if (encoding.length(encoder) > 1) {
        this.send(encoding.toUint8Array(encoder));
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), "remote");
    }
  }

  private sendSync(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  }

  private sendAwareness(ids: number[]): void {
    if (ids.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
    this.send(encoding.toUint8Array(encoder));
  }

  private send(message: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
