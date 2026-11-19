import { TFile, TFolder } from "./generated/file-sync.cjs";
export function memoryVault(initial = {}, FileClass = TFile, FolderClass = TFolder) {
  const entries = new Map();
  const contents = new Map();
  const listeners = new Map();
  const trash = [];
  const emit = async (name, ...args) => {
    await Promise.all([...(listeners.get(name) ?? [])].map((callback) => callback(...args)));
  };
  const folderAt = (path) => {
    const folder = new FolderClass(path);
    Object.defineProperty(folder, "children", { get: () => [...entries.values()].filter((file) =>
      file.path !== folder.path && file.path.split("/").slice(0, -1).join("/") === folder.path) });
    return folder;
  };
  const initialParents = (path) => {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (!entries.has(parent)) entries.set(parent, folderAt(parent));
    }
  };
  const vault = {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    getAllLoadedFiles: () => [...entries.values()],
    getFiles: () => [...entries.values()].filter((file) => file instanceof FileClass),
    getMarkdownFiles: () => [...entries.values()].filter((file) => file instanceof FileClass && file.path.endsWith(".md")),
    getAbstractFileByPath: (path) => entries.get(path),
    read: async (file) => contents.get(file.path) ?? "",
    readBinary: async (file) => {
      const value = contents.get(file.path);
      return value instanceof Uint8Array ? new Uint8Array(value).buffer : new TextEncoder().encode(value ?? "").buffer;
    },
    createBinary: async (path, data) => vault.create(path, new Uint8Array(data).slice()),
    modifyBinary: async (file, data) => vault.modify(file, new Uint8Array(data).slice()),
    createFolder: async (path) => {
      const parts = path.split("/");
      for (let index = 1; index <= parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        if (entries.has(parent)) continue;
        const folder = folderAt(parent); entries.set(parent, folder); await emit("create", folder);
      }
    },
    create: async (path, content) => {
      if (entries.has(path)) throw new Error(`File exists: ${path}`);
      const file = new FileClass(path); entries.set(path, file); contents.set(path, content);
      await emit("create", file);
      return file;
    },
    modify: async (file, content) => { contents.set(file.path, content); await emit("modify", file); },
    trash: async (file) => {
      if (file instanceof FolderClass) {
        for (const child of [...file.children]) await vault.trash(child);
      }
      trash.push([file.path, contents.get(file.path)]);
      entries.delete(file.path); contents.delete(file.path); await emit("delete", file);
    },
    rename: async (file, path) => {
      if (file instanceof FolderClass) {
        const oldPath = file.path;
        const descendants = [...entries.values()].filter((child) => child.path === oldPath || child.path.startsWith(oldPath + "/"));
        for (const child of descendants) {
          const previous = child.path, destination = path + previous.slice(oldPath.length);
          const content = contents.get(previous);
          entries.delete(previous); contents.delete(previous); child.path = destination; entries.set(destination, child);
          if (content !== undefined) contents.set(destination, content);
        }
        await emit("rename", file, oldPath); return;
      }
      const oldPath = file.path; const content = contents.get(oldPath);
      entries.delete(oldPath); contents.delete(oldPath); file.path = path;
      entries.set(path, file); contents.set(path, content); await emit("rename", file, oldPath);
    },
  };
  for (const [path, content] of Object.entries(initial)) { initialParents(path); entries.set(path, new FileClass(path)); contents.set(path, content); }
  return { vault, contents, entries, trash, emit };
}
