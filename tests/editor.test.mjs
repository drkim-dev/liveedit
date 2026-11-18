import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of ["window", "document", "MutationObserver", "HTMLElement", "Node", "Window"]) globalThis[key] = dom.window[key];
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
const require = createRequire(import.meta.url);
const Y = require("yjs");
const { createLiveEditExtension, editorInfoField, setEditorFile, EditorState, EditorView, Awareness } = require("./generated/editor.cjs");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(doc = new Y.Doc(), access = null) {
  const files = doc.getMap("files");
  if (files.size === 0) {
    files.set("A.md", new Y.Text("alpha"));
    files.set("B.md", new Y.Text("bravo"));
  }
  const awareness = new Awareness(doc);
  const counts = new Map();
  const fileSync = {
    isTracked: () => true, hasText: (path) => files.has(path), getOrCreateText: (path) => files.get(path),
    markOpen: (path) => counts.set(path, (counts.get(path) ?? 0) + 1),
    markClosed: (path) => counts.set(path, (counts.get(path) ?? 0) - 1),
    onStructureChange: (callback) => {
      files.observe(callback);
      return () => files.unobserve(callback);
    },
  };
  const session = { awareness, fileSync };
  const view = new EditorView({ state: EditorState.create({ doc: "alpha", extensions: [editorInfoField, createLiveEditExtension({
    getSession: () => access?.locked ? null : session,
    isReadOnlyPath: (path) => !!access?.locked && ["A.md", "B.md"].includes(path),
    onAccessChange: access ? (callback) => { access.listeners.add(callback); return () => access.listeners.delete(callback); } : undefined,
  })] }), parent: document.body });
  view.dispatch({ effects: setEditorFile.of({ file: { path: "A.md" } }) });
  return { doc, files, view, awareness, counts, close() { view.destroy(); awareness.destroy(); doc.destroy(); } };
}

test("switching notes does not publish the new buffer into the previous note", async () => {
  const env = setup();
  try {
    await tick();
    env.view.dispatch({ changes: { from: 0, to: env.view.state.doc.length, insert: "bravo" }, effects: setEditorFile.of({ file: { path: "B.md" } }) });
    await tick();
    assert.equal(env.files.get("A.md").toString(), "alpha");
    assert.equal(env.files.get("B.md").toString(), "bravo");
    env.view.dispatch({ changes: { from: 5, insert: "!" } });
    assert.equal(env.files.get("B.md").toString(), "bravo!");
  } finally { env.close(); }
});

test("offline shared editor blocks typing, paste and undo while private notes remain editable", async () => {
  const access = { locked: true, listeners: new Set() };
  const env = setup(new Y.Doc(), access);
  try {
    await tick();
    assert.equal(env.view.state.facet(EditorState.readOnly), true);
    assert.equal(env.view.contentDOM.getAttribute("contenteditable"), "false");
    for (const userEvent of ["input.type", "input.paste", "delete.backward", "undo"]) {
      env.view.dispatch({ changes: { from: 0, to: 5, insert: "forbidden" }, userEvent });
      assert.equal(env.view.state.doc.toString(), "alpha");
    }
    env.view.dispatch({ effects: setEditorFile.of({ file: { path: "Private.md" } }), changes: { from: 0, to: 5, insert: "personal" } });
    await tick();
    assert.equal(env.view.state.facet(EditorState.readOnly), false);
    env.view.dispatch({ changes: { from: 8, insert: " draft" } });
    assert.equal(env.view.state.doc.toString(), "personal draft");
    env.view.dispatch({ effects: setEditorFile.of({ file: { path: "B.md" } }), changes: { from: 0, to: 14, insert: "bravo" } });
    await tick();
    assert.equal(env.view.state.facet(EditorState.readOnly), true);
    env.view.dispatch({ changes: { from: 0, insert: "blocked" } });
    assert.equal(env.view.state.doc.toString(), "bravo");
  } finally { env.close(); }
});

test("disconnect locks immediately and reconnect installs latest text before editing", async () => {
  const access = { locked: false, listeners: new Set() };
  const env = setup(new Y.Doc(), access);
  try {
    await tick();
    env.view.dispatch({ changes: { from: 5, insert: " live" } });
    assert.equal(env.files.get("A.md").toString(), "alpha live");
    access.locked = true;
    // No render tick is needed to reject a keystroke after the connection drops.
    env.view.dispatch({ changes: { from: 10, insert: " offline" } });
    assert.equal(env.view.state.doc.toString(), "alpha live");
    for (const callback of access.listeners) callback();
    await tick();
    assert.equal(env.view.state.facet(EditorState.readOnly), true);
    env.files.set("A.md", new Y.Text("latest shared state"));
    env.view.dispatch({ changes: { from: 0, insert: "still syncing" } });
    assert.equal(env.view.state.doc.toString(), "alpha live");
    access.locked = false;
    for (const callback of access.listeners) callback();
    await tick();
    assert.equal(env.view.state.doc.toString(), "latest shared state");
    assert.equal(env.view.state.facet(EditorState.readOnly), false);
    env.view.dispatch({ changes: { from: 19, insert: "!" } });
    assert.equal(env.files.get("A.md").toString(), "latest shared state!");
  } finally { env.close(); }
  assert.equal(access.listeners.size, 0);
});

test("replacing the shared text keeps subsequent remote edits live", async () => {
  const env = setup();
  try {
    await tick();
    env.files.set("A.md", new Y.Text("replacement"));
    await tick();
    assert.equal(env.view.state.doc.toString(), "replacement");
    env.files.get("A.md").insert(11, "!");
    assert.equal(env.view.state.doc.toString(), "replacement!");
    env.view.dispatch({ changes: { from: 12, insert: "?" } });
    assert.equal(env.files.get("A.md").toString(), "replacement!?");
  } finally { env.close(); }
});

test("three participants keep both notes consistent across switches and edits", async () => {
  const first = setup();
  const secondDoc = new Y.Doc();
  const thirdDoc = new Y.Doc();
  Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(first.doc));
  Y.applyUpdate(thirdDoc, Y.encodeStateAsUpdate(first.doc));
  const envs = [first, setup(secondDoc), setup(thirdDoc)];
  for (const source of envs) source.doc.on("update", (update, origin) => {
    if (origin === "wire") return;
    for (const target of envs) if (target !== source) Y.applyUpdate(target.doc, update, "wire");
  });
  try {
    await tick();
    first.view.dispatch({ changes: { from: 5, insert: " 1" } });
    assert.equal(envs[1].view.state.doc.toString(), "alpha 1");
    envs[1].view.dispatch({ changes: { from: 7, insert: " 2" } });
    envs[2].view.dispatch({ changes: { from: 9, insert: " 3" } });
    for (const env of envs) assert.equal(env.files.get("A.md").toString(), "alpha 1 2 3");
    first.view.dispatch({ changes: { from: 0, to: first.view.state.doc.length, insert: "bravo" }, effects: setEditorFile.of({ file: { path: "B.md" } }) });
    await tick();
    first.view.dispatch({ changes: { from: 5, insert: " B" } });
    for (const env of envs) {
      assert.equal(env.files.get("A.md").toString(), "alpha 1 2 3");
      assert.equal(env.files.get("B.md").toString(), "bravo B");
    }
    envs[1].view.dispatch({ changes: { from: 0, to: 5, insert: "ALPHA" } });
    assert.equal(first.view.state.doc.toString(), "bravo B");
    first.files.delete("B.md");
    await tick();
    first.view.dispatch({ changes: { from: 0, to: first.view.state.doc.length, insert: "orphan buffer" } });
    for (const env of envs) assert.equal(env.files.has("B.md"), false, "a deleted note must not be recreated by its open editor");
  } finally { for (const env of envs) env.close(); }
});
