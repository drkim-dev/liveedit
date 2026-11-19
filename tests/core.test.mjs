import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { LiveEditConnection, buildRoomUrl } from "./generated/connection.cjs";
import { FileSync, TFile, TFolder } from "./generated/file-sync.cjs";
import { memoryVault } from "./vault-fixture.mjs";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const Y = createRequire(import.meta.url)("yjs");
const { WebSocket } = require("ws");
const { LiveEditPlugin, DEFAULT_SETTINGS, LiveEditSettingTab, Setting, VaultGuard, TFile: PluginFile, TFolder: PluginFolder } = createRequire(import.meta.url)("./generated/plugin.cjs");
globalThis.window = globalThis;
globalThis.WebSocket = WebSocket;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await pause(20);
  }
}

test("URLs reject HTTP and preserve the shared token", () => {
  assert.throws(() => buildRoomUrl("http://localhost", "team"));
  const url = new URL(buildRoomUrl("ws://localhost?token=secret", "a/b"));
  assert.equal(url.pathname, "/a%2Fb");
  assert.equal(url.searchParams.get("token"), "secret");
});

test("settings connection button follows connect/reconnect/disconnect state", async () => {
  const listeners = new Set();
  let status = "disconnected", active = false;
  const notify = () => { for (const callback of listeners) callback(); };
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, displayName: "Tester" },
    getConnectionStatus: () => status, isConnected: () => active,
    onConnectionChange: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    reconnect: async () => { active = true; status = "connecting"; notify(); await pause(1); status = "connected"; notify(); },
    disconnect: () => { active = false; status = "disconnected"; notify(); },
  };
  Setting.buttons = [];
  const tab = new LiveEditSettingTab({}, plugin);
  tab.display();
  const [connect, disconnect] = Setting.buttons;
  assert.equal(connect.text, "참여하기"); assert.equal(disconnect.disabled, true);
  const pending = connect.callback();
  assert.equal(connect.text, "연결 중…"); assert.equal(connect.disabled, true);
  await pending;
  assert.equal(connect.text, "재접속"); assert.equal(connect.disabled, false);
  status = "syncing"; notify();
  assert.equal(connect.text, "최신 문서 받는 중…"); assert.equal(connect.disabled, true);
  status = "connected"; notify();
  disconnect.callback();
  assert.equal(connect.text, "재접속"); assert.equal(disconnect.disabled, true);
  tab.hide(); assert.equal(listeners.size, 0);
});

test("host uses Open room and Close room with no room-code or host-key settings", async () => {
  const listeners = new Set();
  let status = "disconnected", opened = 0, active = false;
  const notify = () => { for (const callback of listeners) callback(); };
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, role: "host", displayName: "Host" },
    getConnectionStatus: () => status, isConnected: () => active,
    onConnectionChange: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    reconnect: async () => { opened++; active = true; status = "connected"; notify(); },
    disconnect: () => { active = false; status = "disconnected"; notify(); },
  };
  Setting.buttons = []; Setting.names = [];
  const settings = new LiveEditSettingTab({}, plugin); settings.display();
  const [open, close] = Setting.buttons;
  assert.equal(open.text, "방 개설하기"); assert.equal(opened, 0);
  assert.equal(close.text, "방 닫기");
  assert.equal(Setting.names.includes("방 코드"), false);
  assert.equal(Setting.names.includes("방장 인증 키"), false);
  await open.callback();
  assert.equal(opened, 1); assert.equal(open.text, "방 열림"); assert.equal(open.disabled, true);
  close.callback(); assert.equal(open.text, "방 개설하기");
  settings.hide();
});

test("host plugin startup does not open a room automatically", async () => {
  const fixture = memoryVault({}, PluginFile, PluginFolder);
  const plugin = new LiveEditPlugin({ vault: fixture.vault, workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null, getActiveFile: () => null, getLeftLeaf: () => null, on: () => ({}) } });
  plugin.loadData = async () => ({ ...DEFAULT_SETTINGS, role: "host", autoReconnect: true });
  plugin.addStatusBarItem = () => ({ style: {}, addClass() {}, setText() {} });
  for (const method of ["registerDomEvent", "addSettingTab", "registerEditorExtension", "addCommand"]) plugin[method] = () => {};
  let opened = 0; plugin.connect = async () => { opened++; };
  await plugin.onload();
  assert.equal(opened, 0);
  plugin.onunload();
});

test("keyless host access trusts only the actual server PC", async () => {
  const { isServerPeer } = await import("../server/dist/host-auth.js");
  assert.equal(isServerPeer("127.0.0.1"), true);
  assert.equal(isServerPeer("::1"), true);
  assert.equal(isServerPeer("::ffff:127.0.0.1"), true);
  assert.equal(isServerPeer(undefined), false);
  assert.equal(isServerPeer("198.51.100.42"), false);
});

test("vault guard locks shared writes, allows sync and private notes, and restores methods on unload", async () => {
  const fixture = memoryVault({ "Team/note.md": "original", "Personal/note.md": "private" }, PluginFile, PluginFolder);
  let editable = false;
  const originalCreate = fixture.vault.create;
  const guard = new VaultGuard(fixture.vault, () => "Team", () => editable);
  try {
    await assert.rejects(fixture.vault.create("Team/new.md", "blocked"));
    await assert.rejects(fixture.vault.modify(fixture.entries.get("Team/note.md"), "blocked"));
    await assert.rejects(fixture.vault.trash(fixture.entries.get("Team/note.md")));
    await assert.rejects(fixture.vault.rename(fixture.entries.get("Personal/note.md"), "Team/moved.md"));
    await assert.rejects(fixture.vault.rename(new PluginFolder("Team"), "Elsewhere"));
    await fixture.vault.modify(fixture.entries.get("Personal/note.md"), "personal draft");
    await fixture.vault.create("Personal/new.md", "private new");
    await guard.internalVault.modify(fixture.entries.get("Team/note.md"), "latest from server");
    assert.equal(fixture.contents.get("Team/note.md"), "latest from server");
    assert.equal(fixture.contents.get("Personal/note.md"), "personal draft");
    editable = true;
    await fixture.vault.create("Team/new.md", "allowed");
    assert.equal(fixture.contents.get("Team/new.md"), "allowed");
  } finally { guard.destroy(); }
  assert.equal(fixture.vault.create, originalCreate);
});

test("unloading the guard does not leave locks in another plugin's wrapper", async () => {
  const fixture = memoryVault({}, PluginFile, PluginFolder);
  const guard = new VaultGuard(fixture.vault, () => "Team", () => false);
  const guardedCreate = fixture.vault.create;
  const otherPlugin = (...args) => guardedCreate(...args);
  fixture.vault.create = otherPlugin;
  guard.destroy();
  assert.equal(fixture.vault.create, otherPlugin);
  await fixture.vault.create("Team/unlocked.md", "plugin disabled");
  assert.equal(fixture.contents.get("Team/unlocked.md"), "plugin disabled");
});

test("vault-wide mode needs no folder and leaves other vaults and configuration alone", async () => {
  const shared = memoryVault({ "root.md": "shared", "Notes/note.md": "shared" }, PluginFile, PluginFolder);
  const personal = memoryVault({ "personal.md": "private" }, PluginFile, PluginFolder);
  const guard = new VaultGuard(shared.vault, () => "", () => false);
  try {
    await assert.rejects(shared.vault.modify(shared.entries.get("root.md"), "blocked"));
    await assert.rejects(shared.vault.create("Notes/new.md", "blocked"));
    await shared.vault.create(".obsidian/config.md", "settings");
    await shared.vault.create(".liveedit-backups/copy.md", "backup");
    await personal.vault.modify(personal.entries.get("personal.md"), "private offline work");
    assert.equal(personal.contents.get("personal.md"), "private offline work");
  } finally { guard.destroy(); }
});

test("legacy host scope import adds remaining vault notes without replacing shared content", async () => {
  const doc = new Y.Doc(); doc.getMap("files").set("Team/note.md", new Y.Text("canonical"));
  const fixture = memoryVault({ "Team/note.md": "old", "root.md": "root note", "Other/note.md": "other folder", ".obsidian/config.md": "ignore" });
  const sync = new FileSync({ vault: fixture.vault }, doc, () => "", true);
  try {
    await sync.start();
    await sync.importLocalNotes();
    assert.equal(sync.getOrCreateText("Team/note.md").toString(), "canonical");
    assert.equal(sync.getOrCreateText("root.md").toString(), "root note");
    assert.equal(sync.getOrCreateText("Other/note.md").toString(), "other folder");
    assert.equal(sync.hasText(".obsidian/config.md"), false);
  } finally { sync.destroy(); doc.destroy(); }
});

test("file scope rejects traversal, hidden configuration, and unrelated folders", () => {
  const doc = new Y.Doc();
  const sync = new FileSync({}, doc, () => "Team");
  for (const path of ["../x.md", "Team/../x.md", "Team/.obsidian/x.md", "Other/x.md", "/Team/x.md", "Team\\x.md", "Team/NUL.md", "Team/x:stream.md"]) assert.equal(sync.isTracked(path), false, path);
  assert.equal(sync.isTracked("Team/회의록.md"), true);
  doc.destroy();
});

test("cancelled initialization does not register vault handlers", async () => {
  const doc = new Y.Doc();
  let registered = 0;
  const app = { vault: { getMarkdownFiles: () => [], off() {}, on() { registered++; } } };
  const sync = new FileSync(app, doc, () => "");
  sync.destroy();
  await sync.start();
  assert.equal(registered, 0);
  doc.destroy();
});

test("vault: scope isolation, split panes, folder renames, and recoverable deletion", async () => {
  const doc = new Y.Doc();
  const files = doc.getMap("files");
  files.set("Other/private.md", new Y.Text("private"));
  files.set("Team/Old/note.md", new Y.Text("one"));
  const entries = new Map();
  const contents = new Map();
  entries.set("Team/Old/note.md", new TFile("Team/Old/note.md"));
  contents.set("Team/Old/note.md", "local only");
  const handlers = new Map();
  const trashed = [];
  const vault = {
    on: (event, callback) => handlers.set(event, callback), off() {},
    getMarkdownFiles: () => [...entries.values()].filter((entry) => entry instanceof TFile),
    getAbstractFileByPath: (path) => entries.get(path),
    read: async (file) => contents.get(file.path) ?? "",
    createFolder: async (path) => entries.set(path, new TFolder(path)),
    create: async (path, content) => { entries.set(path, new TFile(path)); contents.set(path, content); },
    modify: async (file, content) => { contents.set(file.path, content); },
    trash: async (file) => { trashed.push(file.path); entries.delete(file.path); },
  };
  const sync = new FileSync({ vault }, doc, () => "Team", false);
  try {
    await sync.start();
    assert.equal(entries.has("Other/private.md"), false);
    assert.equal(contents.get("Team/Old/note.md"), "one");
    assert.equal([...contents].find(([path]) => path.startsWith(".liveedit-backups/"))?.[1], "local only");
    sync.markOpen("Team/Old/note.md");
    sync.markOpen("Team/Old/note.md");
    sync.markClosed("Team/Old/note.md");
    files.get("Team/Old/note.md").insert(3, " two");
    await pause(450);
    assert.equal(contents.get("Team/Old/note.md"), "one", "one pane is still bound");
    sync.markClosed("Team/Old/note.md");
    await until(() => contents.get("Team/Old/note.md") === "one two");
    // Obsidian emits a single folder rename, not one event per descendant.
    const note = entries.get("Team/Old/note.md");
    entries.delete(note.path);
    contents.delete(note.path);
    note.path = "Team/Renamed/note.md";
    entries.set(note.path, note);
    contents.set(note.path, "one two");
    await handlers.get("rename")(new TFolder("Team/Renamed"), "Team/Old");
    assert.equal(sync.hasText("Team/Old/note.md"), false);
    assert.equal(sync.getOrCreateText("Team/Renamed/note.md").toString(), "one two");
    assert.equal(files.get("Team/Old/note.md").toString(), "one two", "rename preserves the shared text identity");
    files.delete("Other/private.md");
    files.delete("Team/Old/note.md");
    await until(() => trashed.length === 1);
    assert.deepEqual(trashed, ["Team/Renamed/note.md"]);
  } finally { sync.destroy(); doc.destroy(); }
});

test("an initialized empty room is not repopulated from stale host files", async () => {
  const doc = new Y.Doc();
  doc.getMap("liveedit").set("initialized", true);
  const app = { vault: {
    getMarkdownFiles: () => [new TFile("stale.md")],
    read: async () => "deleted content", on() {}, off() {},
  } };
  const sync = new FileSync(app, doc, () => "", true);
  try {
    await sync.start();
    assert.equal(doc.getMap("files").size, 0);
  } finally { sync.destroy(); doc.destroy(); }
});

test("a delayed disk read cannot overwrite a newer remote edit", async () => {
  const doc = new Y.Doc();
  const files = doc.getMap("files");
  files.set("note.md", new Y.Text("initial"));
  const handlers = new Map();
  let releaseRead;
  let disk = "initial";
  const file = new TFile("note.md");
  const vault = {
    on: (name, cb) => handlers.set(name, cb), off() {},
    getMarkdownFiles: () => [file],
    getAbstractFileByPath: () => file,
    read: async () => disk,
    modify: async (_, content) => { disk = content; },
  };
  const sync = new FileSync({ vault }, doc, () => "", false);
  try {
    await sync.start();
    vault.read = () => new Promise((resolve) => { releaseRead = resolve; });
    const pending = handlers.get("modify")(file);
    files.get("note.md").insert(7, " remote");
    vault.read = async () => disk;
    releaseRead("initial");
    await pending;
    assert.equal(files.get("note.md").toString(), "initial remote");
    await until(() => disk === "initial remote");
  } finally { sync.destroy(); doc.destroy(); }
});

test("participant join restores canonical content and removes offline-only notes after backup", async () => {
  const doc = new Y.Doc();
  doc.getMap("files").set("Team/note.md", new Y.Text("shared"));
  doc.getMap("files").set("Team/restored.md", new Y.Text("restore"));
  const fixture = memoryVault({ "Team/note.md": "offline edit", "Team/extra.md": "offline new", "Private/local.md": "keep" });
  const sync = new FileSync({ vault: fixture.vault }, doc, () => "Team", false, new Map([["Team/note.md", "unsaved draft"]]));
  try {
    await sync.start();
    assert.equal(fixture.contents.get("Team/note.md"), "shared");
    assert.equal(fixture.contents.get("Team/restored.md"), "restore");
    assert.equal(fixture.contents.has("Team/extra.md"), false);
    assert.equal(fixture.contents.get("Private/local.md"), "keep");
    for (const content of ["offline edit", "offline new", "unsaved draft"]) assert.ok([...fixture.contents].some(([path, value]) => path.startsWith(".liveedit-backups/") && value === content), content);
    assert.equal(doc.getMap("files").size, 2, "no local content is uploaded on join");
  } finally { sync.destroy(); doc.destroy(); }
});

test("sync completion flushes delayed writes and reports a failed disk write", async () => {
  const doc = new Y.Doc();
  doc.getMap("files").set("Team/note.md", new Y.Text("initial"));
  const fixture = memoryVault({ "Team/note.md": "initial" });
  const sync = new FileSync({ vault: fixture.vault }, doc, () => "Team", false);
  const originalError = console.error;
  try {
    await sync.start();
    doc.getMap("files").get("Team/note.md").insert(7, " latest");
    await sync.settled(true);
    assert.equal(fixture.contents.get("Team/note.md"), "initial latest");
    fixture.vault.modify = async () => { throw new Error("disk write failed"); };
    doc.getMap("files").get("Team/note.md").insert(14, "!");
    console.error = () => {};
    await assert.rejects(sync.settled(true), /disk write failed/);
  } finally { console.error = originalError; sync.destroy(); doc.destroy(); }
});

test("rename and concurrent remote edit preserve the same text; old path can be created again", async () => {
  const a = new Y.Doc();
  a.getMap("files").set("Team/note.md", new Y.Text("initial"));
  const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const va = memoryVault({ "Team/note.md": "initial" });
  const vb = memoryVault({ "Team/note.md": "initial" });
  const sa = new FileSync({ vault: va.vault }, a, () => "Team", true);
  const sb = new FileSync({ vault: vb.vault }, b, () => "Team", false);
  const aUpdates = [], bUpdates = [];
  try {
    await sa.start(); await sb.start();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    a.on("update", (update, origin) => { if (origin !== "wire") aUpdates.push(update); });
    b.on("update", (update, origin) => { if (origin !== "wire") bUpdates.push(update); });
    const original = sa.getOrCreateText("Team/note.md");
    await va.vault.rename(va.entries.get("Team/note.md"), "Team/renamed.md");
    sb.getOrCreateText("Team/note.md").insert(7, " remote");
    for (const update of aUpdates.splice(0)) Y.applyUpdate(b, update, "wire");
    for (const update of bUpdates.splice(0)) Y.applyUpdate(a, update, "wire");
    assert.equal(sa.getOrCreateText("Team/renamed.md"), original);
    assert.equal(sa.getOrCreateText("Team/renamed.md").toString(), "initial remote");
    await until(() => vb.contents.get("Team/renamed.md") === "initial remote" && !vb.contents.has("Team/note.md"));
    await va.vault.create("Team/note.md", "new document");
    for (const update of aUpdates.splice(0)) Y.applyUpdate(b, update, "wire");
    await until(() => vb.contents.get("Team/note.md") === "new document");
    assert.equal(sb.getOrCreateText("Team/renamed.md").toString(), "initial remote");
    await va.vault.trash(va.entries.get("Team/note.md"));
    for (const update of aUpdates.splice(0)) Y.applyUpdate(b, update, "wire");
    assert.equal(sb.hasText("Team/note.md"), false);
    assert.equal(sb.hasText("Team/renamed.md"), true);
  } finally { sa.destroy(); sb.destroy(); await Promise.all([sa.settled(), sb.settled()]); a.destroy(); b.destroy(); }
});

test("a create followed by deletion during its disk read cannot resurrect the file", async () => {
  const doc = new Y.Doc(); doc.getMap("liveedit").set("initialized", true);
  const fixture = memoryVault();
  const sync = new FileSync({ vault: fixture.vault }, doc, () => "", true);
  try {
    await sync.start();
    let release;
    fixture.vault.read = () => new Promise((resolve) => { release = resolve; });
    const creating = fixture.vault.create("racing.md", "draft");
    await until(() => !!release);
    await fixture.vault.trash(fixture.entries.get("racing.md"));
    release("draft"); await creating;
    assert.equal(sync.hasText("racing.md"), false);
  } finally { sync.destroy(); doc.destroy(); }
});

test("three peers converge after concurrent create, rename, delete and edit in reversed update order", async () => {
  const base = new Y.Doc();
  base.getMap("files").set("Team/rename.md", new Y.Text("rename base"));
  base.getMap("files").set("Team/delete.md", new Y.Text("delete base"));
  base.getMap("liveedit").set("initialized", true);
  const peers = [];
  const messages = [];
  for (let index = 0; index < 3; index++) {
    const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
    const fixture = memoryVault();
    const sync = new FileSync({ vault: fixture.vault }, doc, () => "Team", false);
    doc.on("update", (update, origin) => { if (origin !== "wire") messages.push({ doc, update }); });
    peers.push({ doc, fixture, sync });
  }
  try {
    for (const peer of peers) await peer.sync.start();
    await Promise.all(peers.map(async ({ fixture, sync }, index) => {
      await fixture.vault.create("Team/collision.md", `created ${index}`);
      await fixture.vault.create(`Team/unique-${index}.md`, `unique ${index}`);
      await fixture.vault.rename(fixture.entries.get("Team/rename.md"), `Team/renamed-${index}.md`);
      sync.getOrCreateText(`Team/renamed-${index}.md`).insert(11, ` peer${index}`);
      if (index === 0) await fixture.vault.trash(fixture.entries.get("Team/delete.md"));
      else await fixture.vault.modify(fixture.entries.get("Team/delete.md"), `edited ${index}`);
    }));
    for (const { doc, update } of messages.reverse()) for (const peer of peers) if (peer.doc !== doc) Y.applyUpdate(peer.doc, update, "wire");
    const expected = [...peers[0].sync.snapshot()].sort();
    assert.equal(peers[0].sync.hasText("Team/delete.md"), false, "deletion wins over concurrent edits of that document");
    for (const peer of peers) assert.deepEqual([...peer.sync.snapshot()].sort(), expected);
    await until(() => peers.every(({ fixture, sync }) => {
      const disk = [...fixture.contents].filter(([path]) => sync.isTracked(path)).sort();
      return JSON.stringify(disk) === JSON.stringify(expected);
    }));
    for (const peer of peers) assert.equal(peer.doc.store.pendingStructs, null);
    assert.ok(peers.some(({ fixture }) => [...fixture.contents.keys()].some((path) => path.includes("replaced-or-deleted"))));
  } finally {
    for (const peer of peers) peer.sync.destroy();
    await Promise.all(peers.map((peer) => peer.sync.settled()));
    for (const peer of peers) peer.doc.destroy(); base.destroy();
  }
});

test("relay: merge, reconnect, host controls, malformed input, heartbeat, disk recovery", { timeout: 45000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "liveedit-test-"));
  const clients = [];
  let child;
  let address;
  let plugin;
  async function start(legacyToken = false) {
    child = spawn(process.execPath, ["dist/server.js"], {
      cwd: new URL("../server/", import.meta.url),
      env: { ...process.env, PORT: "0", LIVEEDIT_HOST_TOKEN: "", LIVEEDIT_TOKEN: legacyToken ? "team-secret" : "", LIVEEDIT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    await until(() => /listening on :(\d+)/.test(output));
    address = `ws://127.0.0.1:${output.match(/listening on :(\d+)/)[1]}/team?token=team-secret`;
  }
  function client(host = false, auto = false) {
    const connectionUrl = new URL(address);
    if (host) { connectionUrl.searchParams.delete("token"); connectionUrl.searchParams.set("role", "host"); }
    const peer = new LiveEditConnection(connectionUrl.toString(), auto, !host);
    peer.awareness.setLocalStateField("user", { name: host ? "Host" : "Member" });
    clients.push(peer);
    peer.connect();
    return peer;
  }
  async function stop() {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  try {
    await start();
    const notOpen = client(false);
    await assert.rejects(notOpen.waitUntilSynced(), /방장이 먼저/);
    const host = client(true);
    await host.waitUntilSynced();
    const notReady = client(false);
    await assert.rejects(notReady.waitUntilSynced(), /방장이 먼저/);
    host.doc.getMap("liveedit").set("initialized", true);
    const member = client(false, true);
    await member.waitUntilSynced();
    assert.equal(host.roomState.host, true);
    assert.equal(member.roomState.host, false);
    const blank = new WebSocket(address + "&protocol=3&name=%20%20&clientId=456");
    assert.equal(await new Promise((resolve) => blank.once("close", (code) => resolve(code))), 4009);
    const extra = Array.from({ length: 14 }, () => client());
    await Promise.all(extra.map((peer) => peer.waitUntilSynced()));
    await until(() => host.roomState.peers.length === 16);
    assert.equal(new Set(host.roomState.peers.map((peer) => peer.color)).size, 16, "colors stay unique beyond the palette");
    const assigned = member.awareness.getLocalState().user.color;
    assert.match(assigned, /^#[0-9a-f]{6}$/);
    member.awareness.setLocalStateField("user", { name: "forged", color: host.awareness.getLocalState().user.color });
    member.awareness.setLocalStateField("viewingFile", "Team/test.md");
    member.awareness.setLocalStateField("line", 12);
    member.awareness.setLocalStateField("editingUntil", Date.now() + 4000);
    await until(() => host.awareness.getStates().get(member.doc.clientID)?.line === 12);
    assert.equal(host.awareness.getStates().get(member.doc.clientID).user.name, "Member");
    assert.equal(host.awareness.getStates().get(member.doc.clientID).user.color, assigned);
    for (const peer of extra) peer.disconnect();
    await until(() => host.roomState.peers.length === 2);
    member.awareness.setLocalStateField("user", { name: "Member", color: assigned });

    const text = new Y.Text("initial");
    host.doc.getMap("files").set("Team/test.md", text);
    host.doc.getMap("files").set("Team/keep.md", new Y.Text("keep"));
    host.doc.getMap("files").set("Team/remove.md", new Y.Text("remove"));
    await until(() => member.doc.getMap("files").get("Team/test.md")?.toString() === "initial");
    await until(() => member.doc.getMap("files").has("Team/remove.md"));
    const oldDocument = member.doc;
    let backedUpDraft;
    member.beforeReset = async () => { backedUpDraft = member.doc.getMap("files").get("Team/test.md").toString(); };
    member.ws.terminate();
    await until(() => member.status === "disconnected");
    member.doc.getMap("files").get("Team/test.md").insert(7, " offline");
    member.doc.getMap("files").set("Team/offline-new.md", new Y.Text("local only"));
    member.doc.getMap("files").delete("Team/keep.md");
    member.doc.getMap("filePaths").set("Team/test.md", "Team/offline-rename.md");
    text.insert(0, "remote ");
    host.doc.getMap("files").delete("Team/remove.md");
    await member.waitUntilSynced();
    assert.notEqual(member.doc, oldDocument, "participant reconnect starts from a fresh document");
    assert.equal(backedUpDraft, "initial offline");
    await until(() => text.toString() === "remote initial");
    assert.equal(member.doc.getMap("files").get("Team/test.md").toString(), text.toString());
    assert.equal(member.doc.getMap("files").has("Team/offline-new.md"), false);
    assert.equal(member.doc.getMap("files").has("Team/keep.md"), true);
    assert.equal(member.doc.getMap("files").has("Team/remove.md"), false);
    assert.equal(member.doc.getMap("filePaths").has("Team/test.md"), false);
    assert.equal(host.doc.getMap("files").has("Team/offline-new.md"), false);
    // Exercise the plugin lifecycle too, including disk reconciliation and the
    // exact manual reconnect action used by the settings button.
    const fixture = memoryVault({ "Team/test.md": "old local", "Team/extra.md": "local extra" }, PluginFile, PluginFolder);
    const personalVault = memoryVault({ "Personal/note.md": "private" }, PluginFile, PluginFolder);
    plugin = new LiveEditPlugin({ vault: fixture.vault, workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null, getActiveFile: () => null, getLeftLeaf: () => null, on: () => ({}) } });
    plugin.settings = { ...DEFAULT_SETTINGS, displayName: "Plugin tester", serverUrl: address, room: "team", sharedFolder: "" };
    plugin.statusBar = { render() {} };
    await plugin.connect();
    assert.equal(plugin.ready, true);
    assert.equal(plugin.isReadOnlyPath("root.md"), false);
    assert.equal(fixture.contents.get("Team/test.md"), "remote initial");
    assert.equal(fixture.contents.has("Team/extra.md"), false);
    const pastedPhoto = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    await fixture.vault.createBinary("Team/pasted.png", pastedPhoto.buffer);
    const pastedHash = createHash("sha256").update(pastedPhoto).digest("hex");
    await until(() => host.doc.getMap("imageRefs").get("Team/pasted.png") === pastedHash);
    assert.deepEqual(await host.getBlob(pastedHash), pastedPhoto);
    const imageViewer = client(); await imageViewer.waitUntilSynced();
    const imageVault = memoryVault();
    const imageSync = new FileSync({ vault: imageVault.vault }, imageViewer.doc, () => "", false,
      new Map(), () => true, imageVault.vault, imageViewer);
    try {
      await imageSync.start(); await imageSync.settled(true);
      assert.deepEqual(imageVault.contents.get("Team/pasted.png"), pastedPhoto);
    } finally { imageSync.destroy(); imageViewer.disconnect(); }
    plugin.connection.ws.terminate();
    await until(() => plugin.getConnectionStatus() === "disconnected");
    assert.equal(plugin.canEditShared(), false);
    assert.equal(plugin.isReadOnlyPath("root.md"), true);
    await personalVault.vault.modify(personalVault.entries.get("Personal/note.md"), "private offline work");
    assert.equal(personalVault.contents.get("Personal/note.md"), "private offline work");
    await assert.rejects(fixture.vault.modify(fixture.entries.get("Team/test.md"), "blocked offline draft"));
    // External tools bypass the app guard. Their changes still must not upload.
    fixture.contents.set("Team/test.md", "auto offline draft");
    await fixture.emit("modify", fixture.entries.get("Team/test.md"));
    await until(() => plugin.getConnectionStatus() === "connected" && plugin.ready);
    assert.equal(fixture.contents.get("Team/test.md"), "remote initial");
    assert.deepEqual(fixture.contents.get("Team/pasted.png"), pastedPhoto);
    assert.equal(text.toString(), "remote initial");
    assert.ok([...fixture.contents.values()].includes("auto offline draft"));
    plugin.settings.autoReconnect = false;
    await plugin.saveSettings();
    plugin.connection.ws.terminate();
    await until(() => plugin.getConnectionStatus() === "disconnected");
    await assert.rejects(fixture.vault.modify(fixture.entries.get("Team/test.md"), "blocked manual draft"));
    fixture.contents.set("Team/test.md", "manual offline draft");
    await fixture.emit("modify", fixture.entries.get("Team/test.md"));
    const originalRead = fixture.vault.read;
    let releaseDisk;
    let gateUsed = false;
    fixture.vault.read = async (file) => {
      const current = await originalRead(file);
      if (file.path === "Team/test.md" && !gateUsed) {
        gateUsed = true;
        return new Promise((resolve) => { releaseDisk = () => resolve(current); });
      }
      return current;
    };
    const joining = plugin.reconnect();
    await until(() => !!releaseDisk);
    assert.equal(plugin.getConnectionStatus(), "syncing");
    assert.equal(plugin.canEditShared(), false);
    await assert.rejects(fixture.vault.create("Team/too-early.md", "blocked during sync"));
    text.insert(0, "fresh ");
    await until(() => plugin.fileSync.getOrCreateText("Team/test.md").toString() === "fresh remote initial");
    releaseDisk();
    await joining;
    assert.equal(plugin.ready, true);
    assert.equal(fixture.contents.get("Team/test.md"), "fresh remote initial");
    assert.equal(text.toString(), "fresh remote initial");
    assert.equal(personalVault.contents.get("Personal/note.md"), "private offline work");
    assert.ok([...fixture.contents.values()].includes("manual offline draft"));
    plugin.disconnect();
    await pause(400);
    const stateFile = join(dataDir, readdirSync(dataDir).find((name) => name.endsWith(".yjs")));
    const beforeSave = statSync(stateFile).mtimeMs;
    const journalFile = stateFile + ".journal";
    const beforeJournal = readdirSync(dataDir).some((name) => name.endsWith(".journal")) ? statSync(journalFile).size : 0;
    const originalLength = text.length;
    const continuous = setInterval(() => text.insert(text.length, "."), 40);
    try {
      await pause(650);
      assert.ok(statSync(stateFile).mtimeMs > beforeSave || statSync(journalFile).size > beforeJournal,
        "continuous editing must not postpone every disk save");
    } finally { clearInterval(continuous); }
    text.delete(originalLength, text.length - originalLength);
    host.doc.getMap("filePaths").set("Team/test.md", "Team/moved.md");
    await until(() => member.doc.getMap("filePaths").get("Team/test.md") === "Team/moved.md");
    host.control("lock", true);
    await until(() => host.roomState.locked);
    const blocked = client();
    await until(() => blocked.lastError.includes("잠갔"));
    assert.equal(blocked.status, "disconnected");
    host.control("lock", false);
    await until(() => !host.roomState.locked);
    const rogue = client();
    await rogue.waitUntilSynced();
    rogue.control("lock", true);
    await until(() => rogue.lastError.includes("권한"));
    assert.equal(host.roomState.locked, false);
    await until(() => host.roomState.peers.some((peer) => peer.clientIds.includes(member.doc.clientID)));
    host.control("kick", host.roomState.peers.find((peer) => peer.clientIds.includes(member.doc.clientID)).id);
    await until(() => member.lastError.includes("종료"));
    await pause(2200);
    assert.equal(member.status, "disconnected", "kicked clients must not automatically rejoin");
    const malformed = new WebSocket(address + "&protocol=3&name=Malformed&clientId=123");
    await new Promise((resolve) => malformed.once("open", resolve));
    const closed = new Promise((resolve) => malformed.once("close", (code) => resolve(code)));
    malformed.send(Buffer.from([0, 255]));
    assert.equal(await closed, 1002);
    const legacy = new WebSocket(address);
    const legacyCode = await new Promise((resolve) => legacy.once("close", (code) => resolve(code)));
    assert.equal(legacyCode, 4005, "incompatible clients cannot overwrite renamed documents");
    const oldPhotoClient = new WebSocket(address + "&protocol=2&name=Old&clientId=125");
    assert.equal(await new Promise((resolve) => oldPhotoClient.once("close", (code) => resolve(code))), 4005);
    // Cross the first heartbeat: the client must reply without being disconnected.
    await pause(20500);
    assert.equal(host.status, "connected");
    const photoBytes = new Uint8Array(17 * 1024 * 1024); photoBytes[0] = 137; photoBytes[photoBytes.length - 1] = 99;
    const photoHash = createHash("sha256").update(photoBytes).digest("hex");
    await host.putBlob(photoHash, photoBytes);
    host.doc.transact(() => {
      host.doc.getMap("imageRefs").set("Photos/large.png", photoHash);
      host.doc.getMap("imagePaths").set("Photos/large.png", "Photos/large.png");
    });
    const liveMember = client(); await liveMember.waitUntilSynced();
    await until(() => liveMember.doc.getMap("imageRefs").get("Photos/large.png") === photoHash);
    assert.equal((await liveMember.getBlob(photoHash)).at(-1), 99);
    assert.ok((await liveMember.getBlob(photoHash)).length === photoBytes.length);
    host.disconnect();
    await until(() => liveMember.status === "disconnected");
    assert.match(liveMember.lastError, /방장이 방을 닫았/);
    const waiting = client(); await assert.rejects(waiting.waitUntilSynced(), /방장이 먼저/);
    for (const peer of clients) peer.disconnect();
    await pause(100);
    await stop();
    await start(true);
    const recovered = client(true);
    await recovered.waitUntilSynced();
    assert.equal(recovered.doc.getMap("files").get("Team/test.md").toString(), "fresh remote initial");
    assert.equal(recovered.doc.getMap("imageRefs").get("Photos/large.png"), photoHash);
    assert.equal((await recovered.getBlob(photoHash)).at(-1), 99);
    assert.equal(recovered.doc.getMap("filePaths").get("Team/test.md"), "Team/moved.md");
  } finally {
    plugin?.disconnect();
    for (const peer of clients) peer.destroy();
    if (child && child.exitCode === null) await stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});


async function folderPeers(initial = { "Team/Sub/note.md": "shared" }, remoteExtra = {}) {
  const a = new Y.Doc(), b = new Y.Doc();
  const va = memoryVault(initial), vb = memoryVault({ ...initial, ...remoteExtra });
  await va.vault.createFolder("Team/Empty/Deep");
  const sa = new FileSync({ vault: va.vault }, a, () => "Team", true);
  await sa.start(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sb = new FileSync({ vault: vb.vault }, b, () => "Team", false);
  await sb.start();
  let online = true;
  a.on("update", (update, origin) => { if (online && origin !== "wire") Y.applyUpdate(b, update, "wire"); });
  b.on("update", (update, origin) => { if (online && origin !== "wire") Y.applyUpdate(a, update, "wire"); });
  return { a, b, va, vb, sa, sb, offline() { online = false; },
    async settle() { await sa.settled(true); await sb.settled(true); },
    async close() { sa.destroy(); sb.destroy(); await sa.settled(); await sb.settled(); a.destroy(); b.destroy(); } };
}

test("folder create, recursive delete, empty folder delete and rapid recreation synchronize both ways", async () => {
  const env = await folderPeers();
  const { a, b, va, vb, sa, sb } = env;
  try {
    assert.ok(vb.entries.has("Team/Empty/Deep"));
    await va.vault.trash(va.entries.get("Team/Sub")); await env.settle();
    assert.equal(vb.entries.has("Team/Sub/note.md"), false);
    assert.equal(vb.entries.has("Team/Sub"), false);
    assert.equal(b.getMap("folderStates").get("Team/Sub"), false);
    assert.ok([...vb.contents].some(([path, content]) => path.startsWith(".liveedit-backups/") && content === "shared"));
    await vb.vault.trash(vb.entries.get("Team/Empty")); await env.settle();
    assert.equal(va.entries.has("Team/Empty"), false); assert.equal(va.entries.has("Team/Empty/Deep"), false);
    await va.vault.createFolder("Team/Again/Nested"); await env.settle();
    assert.ok(vb.entries.has("Team/Again/Nested"));
    await va.vault.trash(va.entries.get("Team/Again"));
    await va.vault.createFolder("Team/Again/Nested"); await env.settle();
    assert.ok(vb.entries.has("Team/Again/Nested"));
    assert.equal(a.getMap("folderStates").get("Team/Again"), true);
    assert.equal(b.getMap("folderStates").get("Team/Again"), true);
  } finally { await env.close(); }
});

test("folder rename moves empty descendants and preserves text identity, deletion records survive reconnect", async () => {
  const env = await folderPeers(); const { a, b, va, vb, sa, sb } = env;
  let rejoined, saved;
  try {
    await va.vault.createFolder("Team/Sub/Empty"); await env.settle();
    const text = sa.getOrCreateText("Team/Sub/note.md");
    await va.vault.rename(va.entries.get("Team/Sub"), "Team/Renamed"); await env.settle();
    assert.equal(sa.getOrCreateText("Team/Renamed/note.md"), text);
    assert.equal(sb.hasText("Team/Sub/note.md"), false);
    assert.equal(vb.entries.has("Team/Sub"), false);
    assert.ok(vb.entries.has("Team/Renamed/Empty"));
    const staleVault = memoryVault({ "Team/Renamed/note.md": "offline stale" });
    await staleVault.vault.createFolder("Team/Renamed/Empty");
    await staleVault.vault.createFolder("Team/OldLeftover/Empty");
    await va.vault.trash(va.entries.get("Team/Renamed")); await env.settle();
    saved = new Y.Doc(); Y.applyUpdate(saved, Y.encodeStateAsUpdate(a));
    rejoined = new FileSync({ vault: staleVault.vault }, saved, () => "Team", false);
    await rejoined.start(); await rejoined.settled(true);
    assert.equal(staleVault.entries.has("Team/Renamed"), false);
    assert.equal(staleVault.entries.has("Team/Renamed/Empty"), false);
    assert.equal(staleVault.entries.has("Team/OldLeftover"), false);
    assert.ok([...staleVault.contents].some(([path, content]) => path.startsWith(".liveedit-backups/") && content === "offline stale"));
  } finally { rejoined?.destroy(); await rejoined?.settled(); saved?.destroy(); await env.close(); }
});

test("concurrent folder deletion and edits do not resurrect old notes or erase concurrent new notes", async () => {
  const env = await folderPeers(); const { a, b, va, vb, sa, sb } = env;
  try {
    env.offline();
    await va.vault.trash(va.entries.get("Team/Sub"));
    sb.getOrCreateText("Team/Sub/note.md").insert(6, " remote work");
    await vb.vault.create("Team/Sub/new.md", "new concurrent note");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "wire");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "wire");
    await env.settle();
    for (const fixture of [va, vb]) {
      assert.equal(fixture.entries.has("Team/Sub/note.md"), false);
      assert.equal(fixture.contents.get("Team/Sub/new.md"), "new concurrent note");
      assert.ok(fixture.entries.has("Team/Sub"));
    }
    assert.ok([...vb.contents].some(([path, content]) => path.startsWith(".liveedit-backups/") && content.includes("remote work")));
  } finally { await env.close(); }
});

test("remote folder deletion retains local attachments, hidden files and unrelated folders", async () => {
  const env = await folderPeers(undefined, { "Team/Sub/document.pdf": "attachment", "Team/Sub/.private.md": "hidden", "Other/personal.md": "private" });
  const { va, vb } = env;
  try {
    await va.vault.trash(va.entries.get("Team/Sub")); await env.settle();
    assert.equal(vb.contents.has("Team/Sub/note.md"), false);
    assert.equal(vb.contents.get("Team/Sub/document.pdf"), "attachment");
    assert.equal(vb.contents.get("Team/Sub/.private.md"), "hidden");
    assert.equal(vb.contents.get("Other/personal.md"), "private");
    assert.ok(vb.entries.has("Team/Sub"));
  } finally { await env.close(); }
});


test("a new shared note arriving during folder trash is restored without publishing a deletion", async () => {
  const env = await folderPeers(); const { va, vb, b, sb } = env;
  const originalTrash = vb.vault.trash;
  let releaseTrash, enteredTrash;
  const entered = new Promise((resolve) => enteredTrash = resolve);
  vb.vault.trash = async (file, ...args) => {
    if (file.path === "Team/Sub") {
      enteredTrash(); await new Promise((resolve) => releaseTrash = resolve);
    }
    return originalTrash(file, ...args);
  };
  try {
    await va.vault.trash(va.entries.get("Team/Sub"));
    await entered;
    // Simulate another peer's file reaching disk while the earlier trash awaits I/O.
    b.transact(() => {
      b.getMap("files").set("Team/Sub/new.md", new Y.Text("new data"));
      b.getMap("filePaths").set("Team/Sub/new.md", "Team/Sub/new.md");
    }, "wire");
    await vb.vault.create("Team/Sub/new.md", "new data");
    releaseTrash(); await env.settle();
    assert.equal(sb.hasText("Team/Sub/new.md"), true);
    assert.equal(vb.contents.get("Team/Sub/new.md"), "new data");
    assert.equal(vb.contents.has("Team/Sub/note.md"), false);
  } finally { releaseTrash?.(); await env.close(); }
});


const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
async function imagePeers(extraRemote = {}) {
  const a = new Y.Doc(), b = new Y.Doc();
  const va = memoryVault({ "Team/note.md": "![[Photos/original.png]]", "Team/Photos/original.png": png });
  const vb = memoryVault({ "Team/note.md": "stale", ...extraRemote });
  const sa = new FileSync({ vault: va.vault }, a, () => "Team", true);
  await sa.start(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  let editable = true, online = true;
  const sb = new FileSync({ vault: vb.vault }, b, () => "Team", false, new Map(), () => editable);
  await sb.start();
  a.on("update", (update, origin) => { if (online && origin !== "wire") Y.applyUpdate(b, update, "wire"); });
  b.on("update", (update, origin) => { if (online && origin !== "wire") Y.applyUpdate(a, update, "wire"); });
  return { a, b, va, vb, sa, sb, setEditable(value) { editable = value; }, offline() { online = false; },
    exchange() { Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "wire"); Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "wire"); },
    async settle() { await sa.settled(true); await sb.settled(true); },
    async close() { sa.destroy(); sb.destroy(); await sa.settled(); await sb.settled(); a.destroy(); b.destroy(); } };
}

test("photos pasted by host and member copy as binary to the same paths without changing markdown links", async () => {
  const env = await imagePeers(); const { a, b, va, vb } = env;
  try {
    assert.deepEqual(vb.contents.get("Team/Photos/original.png"), png);
    assert.equal(vb.contents.get("Team/note.md"), "![[Photos/original.png]]");
    await Promise.all([
      va.vault.createBinary("Team/Photos/from-host.jpg", Uint8Array.from([255,216,0,255,217]).buffer),
      vb.vault.createBinary("Team/Photos/from-member.webp", Uint8Array.from([82,73,70,70,0,255]).buffer),
    ]);
    await env.settle();
    assert.deepEqual(va.contents.get("Team/Photos/from-member.webp"), vb.contents.get("Team/Photos/from-member.webp"));
    assert.deepEqual(va.contents.get("Team/Photos/from-host.jpg"), vb.contents.get("Team/Photos/from-host.jpg"));
    assert.equal(a.getMap("images").size, 3); assert.equal(b.getMap("images").size, 3);
    const before = Y.encodeStateAsUpdate(a).length;
    await env.settle(); assert.equal(Y.encodeStateAsUpdate(a).length, before, "remote writes do not echo as new uploads");
    await vb.vault.trash(vb.entries.get("Team/Photos/from-host.jpg")); await env.settle();
    assert.equal(va.contents.has("Team/Photos/from-host.jpg"), false);
    assert.ok([...va.contents].some(([path, bytes]) => path.startsWith(".liveedit-backups/") && bytes instanceof Uint8Array && bytes[0] === 255));
  } finally { await env.close(); }
});

test("photo folder rename preserves binary identity and folder deletion removes shared photos", async () => {
  const env = await imagePeers(); const { a, b, va, vb } = env;
  try {
    const id = [...a.getMap("images").keys()][0];
    await vb.vault.rename(vb.entries.get("Team/Photos"), "Team/Pictures"); await env.settle();
    assert.equal(a.getMap("imagePaths").get(id), "Team/Pictures/original.png");
    assert.deepEqual(va.contents.get("Team/Pictures/original.png"), png);
    assert.equal(va.entries.has("Team/Photos"), false);
    await va.vault.trash(va.entries.get("Team/Pictures")); await env.settle();
    assert.equal(vb.entries.has("Team/Pictures"), false);
    assert.equal(b.getMap("images").size, 0);
  } finally { await env.close(); }
});

test("offline photo changes are backed up and reconnect restores the shared bytes", async () => {
  const env = await imagePeers({ "Other/private.jpg": Uint8Array.from([1,2,3]), ".obsidian/private.png": Uint8Array.from([4,5,6]) });
  const { vb, sb, a } = env;
  try {
    env.setEditable(false);
    await vb.vault.modifyBinary(vb.entries.get("Team/Photos/original.png"), Uint8Array.from([9,8,7]).buffer);
    await vb.vault.createBinary("Team/offline.png", Uint8Array.from([6,5,4]).buffer);
    assert.deepEqual(a.getMap("images").get("Team/Photos/original.png"), png);
    await sb.resynchronize(); await env.settle();
    assert.deepEqual(vb.contents.get("Team/Photos/original.png"), png);
    assert.equal(vb.entries.has("Team/offline.png"), false);
    assert.ok([...vb.contents].some(([path, bytes]) => path.startsWith(".liveedit-backups/") && bytes instanceof Uint8Array && bytes[0] === 9));
    assert.deepEqual(vb.contents.get("Other/private.jpg"), Uint8Array.from([1,2,3]));
    assert.deepEqual(vb.contents.get(".obsidian/private.png"), Uint8Array.from([4,5,6]));
  } finally { await env.close(); }
});

test("a delayed local photo read cannot overwrite newer shared image bytes", async () => {
  const env = await imagePeers(); const { va, vb } = env;
  const originalRead = vb.vault.readBinary;
  let release;
  try {
    vb.vault.readBinary = () => new Promise((resolve) => release = resolve);
    const pending = vb.vault.modifyBinary(vb.entries.get("Team/Photos/original.png"), Uint8Array.from([7,7]).buffer);
    await until(() => !!release);
    vb.vault.readBinary = originalRead;
    await va.vault.modifyBinary(va.entries.get("Team/Photos/original.png"), Uint8Array.from([8,8,8]).buffer);
    release(Uint8Array.from([7,7]).buffer); await pending; await env.settle();
    assert.deepEqual(vb.contents.get("Team/Photos/original.png"), Uint8Array.from([8,8,8]));
    assert.deepEqual(va.contents.get("Team/Photos/original.png"), Uint8Array.from([8,8,8]));
    assert.ok([...vb.contents].some(([path, bytes]) => path.startsWith(".liveedit-backups/") && bytes instanceof Uint8Array && bytes[0] === 7));
  } finally { vb.vault.readBinary = originalRead; release?.(png.buffer); await env.close(); }
});

test("photo read followed by deletion cannot resurrect the attachment", async () => {
  const env = await imagePeers(); const { vb, a } = env;
  const originalRead = vb.vault.readBinary; let release;
  try {
    vb.vault.readBinary = () => new Promise((resolve) => release = resolve);
    const pending = vb.vault.createBinary("Team/racing.png", Uint8Array.from([1,2]).buffer);
    await until(() => !!release);
    vb.vault.readBinary = originalRead;
    await vb.vault.trash(vb.entries.get("Team/racing.png")); release(Uint8Array.from([1,2]).buffer);
    await pending; await env.settle();
    assert.equal(a.getMap("images").has("Team/racing.png"), false);
  } finally { vb.vault.readBinary = originalRead; release?.(png.buffer); await env.close(); }
});



test("concurrent photo creation converges and rename plus replacement preserves the shared image", async () => {
  const env = await imagePeers(); const { va, vb, a, b } = env;
  try {
    env.offline();
    await va.vault.createBinary("Team/same.png", Uint8Array.from([1,2,3]).buffer);
    await vb.vault.createBinary("Team/same.png", Uint8Array.from([4,5,6]).buffer);
    env.exchange(); await env.settle();
    assert.deepEqual(va.contents.get("Team/same.png"), vb.contents.get("Team/same.png"));
    assert.ok([...va.contents, ...vb.contents].some(([path, bytes]) => path.startsWith(".liveedit-backups/") && bytes instanceof Uint8Array && [1,4].includes(bytes[0])));
    await va.vault.rename(va.entries.get("Team/Photos/original.png"), "Team/Photos/renamed.png");
    await vb.vault.modifyBinary(vb.entries.get("Team/Photos/original.png"), Uint8Array.from([7,8,9]).buffer);
    env.exchange(); await env.settle();
    for (const fixture of [va, vb]) {
      assert.deepEqual(fixture.contents.get("Team/Photos/renamed.png"), Uint8Array.from([7,8,9]));
      assert.equal(fixture.entries.has("Team/Photos/original.png"), false);
    }
    assert.deepEqual(a.getMap("imagePaths").toJSON(), b.getMap("imagePaths").toJSON());
  } finally { await env.close(); }
});

test("an oversized photo remains local and does not stop note collaboration", async () => {
  const env = await imagePeers(); const { va, a } = env;
  try {
    await va.vault.createBinary("Team/too-large.png", new Uint8Array(21 * 1024 * 1024).buffer);
    await env.settle();
    assert.ok(va.entries.has("Team/too-large.png"));
    assert.equal(a.getMap("images").has("Team/too-large.png"), false);
    assert.equal(a.getMap("files").get("Team/note.md").toString(), "![[Photos/original.png]]");
  } finally { await env.close(); }
});


test("deleting a photo while another peer replaces its bytes does not resurrect the photo", async () => {
  const env = await imagePeers(); const { va, vb } = env;
  try {
    env.offline();
    await va.vault.trash(va.entries.get("Team/Photos/original.png"));
    await vb.vault.modifyBinary(vb.entries.get("Team/Photos/original.png"), Uint8Array.from([10,11,12]).buffer);
    env.exchange(); await env.settle();
    assert.equal(va.entries.has("Team/Photos/original.png"), false);
    assert.equal(vb.entries.has("Team/Photos/original.png"), false);
    assert.ok([...vb.contents].some(([path, bytes]) => path.startsWith(".liveedit-backups/") && bytes instanceof Uint8Array && bytes[0] === 10));
  } finally { await env.close(); }
});
