import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
const require = createRequire(import.meta.url);
const { getParticipants, ParticipantsModal, ParticipantsView, LiveEditPlugin, LiveEditSettingTab, DEFAULT_SETTINGS, Setting, TFile, validDisplayName, FileExplorerPresence } = require("./generated/plugin.cjs");
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const proto = dom.window.HTMLElement.prototype;
proto.empty = function () { this.replaceChildren(); };
proto.setText = function (text) { this.textContent = text; };
proto.createEl = function (tag, options = {}) {
  const el = document.createElement(tag);
  if (options.text) el.textContent = options.text;
  if (options.cls) el.className = options.cls;
  this.append(el); return el;
};
proto.createDiv = function (options) { return this.createEl("div", options); };
proto.createSpan = function (options) { return this.createEl("span", options); };

test("blank names disable admission and cannot connect through commands either", async () => {
  for (const name of ["", "  ", "a".repeat(41)]) {
    assert.equal(validDisplayName(name), false);
  }
  assert.equal(validDisplayName("a\nb"), false);
  assert.equal(validDisplayName("김 연구원"), true);
  let opened = 0;
  const plugin = {
    settings: { ...DEFAULT_SETTINGS }, getConnectionStatus: () => "disconnected",
    isConnected: () => false, onConnectionChange: () => () => {}, reconnect: () => { opened++; },
  };
  Setting.buttons = [];
  const tab = new LiveEditSettingTab({}, plugin); tab.display();
  assert.equal(Setting.buttons[0].disabled, true);
  tab.hide();
  const real = new LiveEditPlugin({}); real.settings = { ...DEFAULT_SETTINGS };
  await real.connect(); await real.reconnect();
  assert.equal(real.isConnected(), false);
  assert.match(real.getConnectionMessage(), /이름/);
  assert.equal(opened, 0);
});

test("sidebar and modal include self, update positions and departures, and open the selected line", async () => {
  const states = new Map([[11, { user: { name: "wrong", color: "red" }, viewingFile: "A.md", line: 3, editingUntil: Date.now() + 3000 }]]);
  const connection = {
    status: "connected", doc: { clientID: 11 }, awareness: { getStates: () => states },
    roomState: { host: true, locked: false, selfId: "self", peers: [
      { id: "self", name: "방장", host: true, color: "#1971c2", clientIds: [11] },
      { id: "other", name: "팀원", host: false, color: "#e64980", clientIds: [22] },
    ] }, control() {},
  };
  const listeners = new Set();
  const source = {
    getPresenceConnection: () => connection, getConnectionStatus: () => connection.status,
    onConnectionChange: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const opened = [];
  const app = { vault: { getAbstractFileByPath: (path) => new TFile(path) }, workspace: { getLeaf: () => ({ openFile: (...args) => opened.push(args) }) } };
  const sidebar = new ParticipantsView({ app }, source);
  const modal = new ParticipantsModal(app, source);
  await sidebar.onOpen(); modal.onOpen();
  try {
    const peers = getParticipants(connection.awareness, 11, connection);
    assert.equal(peers.length, 2); assert.equal(peers[0].self, true);
    assert.equal(peers[0].name, "방장"); assert.equal(peers[0].color, "#1971c2");
    for (const el of [sidebar.contentEl, modal.contentEl]) {
      assert.match(el.textContent, /방장 \(나\)/); assert.match(el.textContent, /3행/);
      assert.match(el.textContent, /팀원/);
    }
    sidebar.contentEl.querySelector(".liveedit-note-link").click();
    assert.equal(opened[0][0].path, "A.md"); assert.equal(opened[0][1].eState.line, 2);
    states.set(22, { viewingFile: "Renamed.md", line: 7 });
    connection.roomState.peers = connection.roomState.peers.filter((peer) => peer.id !== "self");
    for (const callback of listeners) callback();
    assert.match(sidebar.contentEl.textContent, /Renamed.md · 7행/);
    assert.doesNotMatch(sidebar.contentEl.textContent, /방장 \(나\)/);
    connection.status = "disconnected";
    for (const callback of listeners) callback();
    assert.match(sidebar.contentEl.textContent, /연결되어 있지 않습니다/);
    assert.equal(sidebar.contentEl.querySelectorAll(".liveedit-participant").length, 0);
  } finally { await sidebar.onClose(); modal.onClose(); }
  assert.equal(listeners.size, 0);
});


test("file explorer shows note occupants inline and preserves native rows across rename, rebuild and disconnect", async () => {
  const roots = [document.createElement("div"), document.createElement("div")];
  const makeRow = (path, parent = roots[0]) => {
    const row = document.createElement("div"); row.className = "nav-file-title"; row.dataset.path = path;
    const filename = document.createElement("span"); filename.className = "nav-file-title-content";
    filename.textContent = path.split("/").at(-1); row.append(filename); parent.append(row); return row;
  };
  const first = makeRow("Team/note.md"), second = makeRow("Private/note.md"), mirror = makeRow("Team/note.md", roots[1]);
  const states = new Map([[11, { viewingFile: "Team/note.md", editingUntil: Date.now() + 3000 }], [22, { viewingFile: "Team/note.md" }], [33, { viewingFile: "Team/note.md" }]]);
  const connection = { status: "connected", doc: { clientID: 11 }, awareness: { getStates: () => states }, roomState: {
    peers: [11, 22, 33].map((id) => ({ id: String(id), clientIds: [id], name: id === 11 ? "민수" : id === 22 ? "영희" : "<b>준호</b>", color: "#1971c2", host: id === 11 })),
  } };
  const listeners = new Set();
  const source = { getPresenceConnection: () => connection, getConnectionStatus: () => connection.status,
    onConnectionChange: (callback) => { listeners.add(callback); return () => listeners.delete(callback); } };
  const app = { workspace: { getLeavesOfType: (type) => type === "file-explorer" ? roots.map((root) => ({ view: { containerEl: root } })) : [] } };
  let clicks = 0; first.onclick = () => clicks++;
  const display = new FileExplorerPresence(app, source);
  try {
    assert.equal(first.querySelector(".nav-file-title-content").textContent, "note.md");
    assert.equal(second.querySelector(".liveedit-file-presence"), null, "same basename in another folder is independent");
    assert.match(first.textContent, /민수/); assert.match(first.querySelector(".liveedit-file-presence").title, /영희/); assert.match(first.textContent, /\+1/);
    const badge = first.querySelector(".liveedit-file-presence");
    assert.match(badge.title, /<b>준호<\/b>/); assert.equal(badge.querySelector("b"), null);
    assert.doesNotMatch(badge.title, /작성 중|보고 있음/);
    badge.click(); assert.equal(clicks, 1, "native file opening still receives clicks");
    assert.ok(mirror.querySelector(".liveedit-file-presence"));
    states.get(11).editingUntil = 0; states.get(11).line = 99;
    display.refresh(); assert.equal(first.querySelector(".liveedit-file-presence"), badge, "typing and cursor movement do not rebuild badges");
    states.get(22).viewingFile = "Private/note.md"; display.refresh();
    assert.match(second.textContent, /영희/); assert.doesNotMatch(first.textContent, /영희/);
    first.dataset.path = "Team/renamed.md";
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    assert.equal(first.querySelector(".liveedit-file-presence"), null, "reused rows lose old occupants");
    states.get(11).viewingFile = "Team/renamed.md"; display.refresh(); assert.match(first.textContent, /민수/);
    first.remove(); const rebuilt = makeRow("Team/renamed.md");
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    assert.match(rebuilt.textContent, /민수/, "lazy/rebuilt tree rows regain badges");
    connection.status = "disconnected"; display.refresh();
    assert.equal(roots.reduce((count, root) => count + root.querySelectorAll(".liveedit-file-presence").length, 0), 0);
    connection.status = "connected"; display.refresh(); assert.match(rebuilt.textContent, /민수/);
  } finally { display.destroy(); }
  assert.equal(listeners.size, 0);
  assert.equal(roots.reduce((count, root) => count + root.querySelectorAll(".liveedit-file-presence").length, 0), 0);
});
