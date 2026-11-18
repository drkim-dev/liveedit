import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Room } from "./room.js";
import { resolve } from "node:path";
import { isServerPeer } from "./host-auth.js";

const PORT = Number(process.env.PORT ?? 1234);
// Optional shared secret so randoms on the same LAN can't join without it.
// Leave COVAULT_TOKEN unset to allow any client on the private network in.
const SHARED_TOKEN = process.env.LIVEEDIT_TOKEN;
const HOST_TOKEN = process.env.LIVEEDIT_HOST_TOKEN;
const DATA_DIR = resolve(process.env.LIVEEDIT_DATA_DIR ?? "./data");

const rooms = new Map<string, Room>();

function getOrCreateRoom(name: string): Room {
  let room = rooms.get(name);
  if (!room) {
    room = new Room(name, (emptyName) => rooms.delete(emptyName), DATA_DIR);
    rooms.set(name, room);
  }
  return room;
}

function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    // Allow the Obsidian plugin (running from an app:// origin) to fetch() this directly.
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({ ok: true, version: "0.6.0", rooms: rooms.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://relay");
  let roomName: string;
  try { roomName = decodeURIComponent(url.pathname.replace(/^\//, "")); }
  catch { socket.destroy(); return; }

  if (!roomName || roomName.length > 200) {
    socket.destroy();
    return;
  }
  const localHostRequest = url.searchParams.get("role") === "host" && isServerPeer(req.socket.remoteAddress);
  if (SHARED_TOKEN && url.searchParams.get("token") !== SHARED_TOKEN && !localHostRequest) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
    if (url.searchParams.get("protocol") !== "2") {
      ws.close(4005, "LiveEdit 플러그인을 0.5.0 이상으로 업데이트해주세요");
      return;
    }
    ws.on("error", (error) => console.warn("Peer error:", error.message));
    const host = (!!HOST_TOKEN && url.searchParams.get("hostToken") === HOST_TOKEN) ||
      localHostRequest;
    if (url.searchParams.get("role") === "host" && !host) {
      ws.close(4001, "방 개설은 서버를 실행한 PC의 Obsidian에서 해주세요");
      return;
    }
    if (url.searchParams.has("hostToken") && !host) {
      ws.close(4001, "방장 인증 키가 올바르지 않습니다");
      return;
    }
    let room: Room;
    try { room = getOrCreateRoom(roomName); }
    catch (error) {
      console.error("Room load failed", error);
      ws.close(1011, "방 데이터를 불러올 수 없습니다");
      return;
    }
    room.join(ws, host);

    ws.on("message", (data, binary) => {
      try {
        if (!binary) { ws.close(1003, "Binary messages required"); return; }
        room.handleMessage(ws, toUint8Array(data));
      } catch { ws.close(1002, "Invalid message"); }
    });
    ws.on("close", () => room.leave(ws));
    ws.on("error", () => room.leave(ws));
  });
});

const alive = new WeakMap<WebSocket, boolean>();
wss.on("connection", (ws) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) { ws.terminate(); continue; }
    alive.set(ws, false);
    ws.ping();
    ws.send(new Uint8Array([3]));
  }
}, 20000);
wss.on("close", () => clearInterval(heartbeat));

function shutdown(): void {
  clearInterval(heartbeat);
  for (const room of rooms.values()) {
    try { room.flush(); } catch (error) { console.error("Final save failed", error); }
    room.destroy();
  }
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  httpServer.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE"
    ? `포트 ${PORT}에서 기존 서버가 실행 중입니다. 기존 서버 창을 닫고 start.cmd를 다시 실행해주세요.`
    : `서버 시작 실패: ${error.message}`);
  shutdown();
  process.exitCode = 1;
});

httpServer.listen(PORT, () => {
  const address = httpServer.address();
  console.log(`liveedit relay listening on :${typeof address === "object" && address ? address.port : PORT}`);
});
