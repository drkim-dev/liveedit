import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const MSG_CONTROL = 2;
export interface RoomState {
  protocol: number;
  lifecycle?: number;
  host: boolean;
  locked: boolean;
  peers: { id: string; host: boolean; clientIds: number[] }[];
}

export type ConnectionStatus = "connecting" | "syncing" | "connected" | "disconnected";

/** Builds the room URL, preserving any query string (e.g. a shared token) already in serverUrl. */
export function buildRoomUrl(serverUrl: string, room: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("WebSocket URL required");
  url.pathname = `/${encodeURIComponent(room)}`;
  url.hash = "";
  return url.toString();
}

/** Builds the relay server's health-check URL (ws(s):// -> http(s)://, path -> /healthz). */
export function buildHealthUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/healthz";
  url.search = "";
  return url.toString();
}

/**
 * Thin Yjs WebSocket peer: only the sync + awareness wire protocols, no
 * IndexedDB persistence or cross-tab sync — those aren't needed here.
 */
export class LiveEditConnection {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  status: ConnectionStatus = "disconnected";

  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private shouldReconnect = false;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  private synced = false;
  private watchdog: number | null = null;
  private connectTimeout: number | null = null;
  private lastMessage = 0;
  private attempts = 0;
  roomState: RoomState | null = null;
  lastError = "";
  private readonly syncedListeners = new Set<() => void>();
  private generation = 0;
  private opened = false;
  beforeReset: (() => Promise<void>) | null = null;

  constructor(private url: string, private autoReconnect: boolean, private readonly resetOnReconnect = false) {
    const address = new URL(url);
    address.searchParams.set("protocol", "2");
    this.url = address.toString();
    this.bindDocument();
  }

  private bindDocument(): void {
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

  /** Only a received sync step 2 establishes that the remote snapshot arrived. */
  waitUntilSynced(timeoutMs = 15000): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.syncedListeners.delete(onSynced);
        unsubscribe();
      };
      const onSynced = () => {
        cleanup();
        resolve();
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error(this.lastError || "서버 동기화 응답 시간 초과"));
      }, timeoutMs);
      const unsubscribe = this.onStatusChange((status) => {
        if (status === "disconnected" && !this.shouldReconnect) {
          cleanup();
          reject(new Error(this.lastError || "연결 취소됨"));
        }
      });
      this.syncedListeners.add(onSynced);
    });
  }

  get willReconnect(): boolean { return this.shouldReconnect; }

  setAutoReconnect(value: boolean): void {
    if (value === this.autoReconnect) return;
    this.autoReconnect = value;
    this.shouldReconnect = value;
    if (!value && this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (value && !this.ws && this.reconnectTimer === null) this.open();
  }

  control(action: "lock" | "kick", value: boolean | string): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_CONTROL);
    encoding.writeVarString(encoder, JSON.stringify({ action, value }));
    this.send(encoding.toUint8Array(encoder));
  }

  connect(): void {
    this.shouldReconnect = this.autoReconnect;
    this.open();
  }

  disconnect(): void {
    this.generation++;
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    if (this.connectTimeout !== null) window.clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
    this.watchdog = null;
    this.synced = false;
    this.ws?.close();
    this.ws = null;
    this.clearRemoteAwareness();
    this.setStatus("disconnected");
  }

  destroy(): void {
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private async open(): Promise<void> {
    if (this.ws) return;
    const generation = ++this.generation;
    this.reconnectTimer = null;
    this.setStatus("connecting");
    this.synced = false;
    if (this.opened && this.resetOnReconnect) {
      try { await this.beforeReset?.(); }
      catch (error) {
        if (generation !== this.generation) return;
        this.lastError = `로컬 사본 보관 실패: ${String(error)}`;
        this.shouldReconnect = false;
        this.setStatus("disconnected");
        return;
      }
      if (generation !== this.generation) return;
      const localState = this.awareness.getLocalState();
      this.awareness.destroy();
      this.doc.destroy();
      this.doc = new Y.Doc();
      this.awareness = new awarenessProtocol.Awareness(this.doc);
      this.bindDocument();
      this.awareness.setLocalState(localState);
    }
    if (generation !== this.generation) return;
    this.opened = true;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.connectTimeout = window.setTimeout(() => ws.close(), 10000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectTimeout !== null) window.clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
      this.lastMessage = Date.now();
      this.watchdog = window.setInterval(() => {
        if (Date.now() - this.lastMessage > 65000) ws.close(4000, "Heartbeat timeout");
      }, 10000);
      // Kick off the mutual sync handshake: tell the server our current state vector.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      this.awareness.setLocalState(this.awareness.getLocalState());
      this.sendAwareness([this.doc.clientID]);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessage = Date.now();
      if (event.data instanceof ArrayBuffer) {
        try { this.handleMessage(new Uint8Array(event.data)); }
        catch { ws.close(1002, "Invalid relay message"); }
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // stale handler from a previous socket
      this.ws = null;
      if (this.connectTimeout !== null) window.clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
      if (this.watchdog !== null) window.clearInterval(this.watchdog);
      this.watchdog = null;
      this.synced = false;
      this.roomState = null;
      this.lastError = event.reason || `서버 연결 실패 (${event.code}). 방장은 서버가 켜져 있는지 확인해주세요.`;
      if ([4001, 4003, 4004, 4005].includes(event.code)) this.shouldReconnect = false;
      this.setStatus("disconnected");
      this.clearRemoteAwareness();
      if (this.shouldReconnect) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5));
        this.reconnectTimer = window.setTimeout(() => this.open(), delay + Math.random() * 500);
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
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
        this.attempts = 0;
        this.lastError = "";
        this.setStatus("connected");
        for (const listener of Array.from(this.syncedListeners)) listener();
      }
      if (encoding.length(encoder) > 1) {
        this.send(encoding.toUint8Array(encoder));
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), "remote");
    } else if (type === MSG_CONTROL) {
      this.roomState = JSON.parse(decoding.readVarString(decoder)) as RoomState;
    } else if (type === 3) {
      this.send(new Uint8Array([3]));
    }
  }

  private sendSync(update: Uint8Array): void {
    if (!this.synced) return;
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
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
