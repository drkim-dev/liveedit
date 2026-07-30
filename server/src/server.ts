import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Room } from "./room.js";

const PORT = Number(process.env.PORT ?? 1234);
// Optional shared secret so randoms on the same LAN can't join without it.
// Leave COVAULT_TOKEN unset to allow any client on the private network in.
const SHARED_TOKEN = process.env.LIVEEDIT_TOKEN;

const rooms = new Map<string, Room>();

function getOrCreateRoom(name: string): Room {
  let room = rooms.get(name);
  if (!room) {
    room = new Room(name, (emptyName) => rooms.delete(emptyName));
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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://relay");
  const roomName = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (!roomName) {
    socket.destroy();
    return;
  }
  if (SHARED_TOKEN && url.searchParams.get("token") !== SHARED_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getOrCreateRoom(roomName);
    room.join(ws);

    ws.on("message", (data) => room.handleMessage(ws, toUint8Array(data)));
    ws.on("close", () => room.leave(ws));
    ws.on("error", () => room.leave(ws));
  });
});

httpServer.listen(PORT, () => {
  console.log(`liveedit relay listening on :${PORT}`);
});
