import { TFile, TFolder } from "./generated/file-sync.cjs";
export function memoryVault(initial = {}, FileClass = TFile, FolderClass = TFolder) {
  const entries = new Map();
  const contents = new Map();
  const listeners = new Map();
  const trash = [];
  const emit = async (name, ...args) => {
    await Promise.all([...(listeners.get(name) ?? [])].map((callback) => callback(...args)));
  };
  const vault = {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    getMarkdownFiles: () => [...entries.values()].filter((file) => file instanceof FileClass && file.path.endsWith(".md")),
    getAbstractFileByPath: (path) => entries.get(path),
    read: async (file) => contents.get(file.path) ?? "",
    createFolder: async (path) => { entries.set(path, new FolderClass(path)); },
    create: async (path, content) => {
      if (entries.has(path)) throw new Error(`File exists: ${path}`);
      const file = new FileClass(path); entries.set(path, file); contents.set(path, content);
      await emit("create", file);
      return file;
    },
    modify: async (file, content) => { contents.set(file.path, content); await emit("modify", file); },
    trash: async (file) => {
      trash.push([file.path, contents.get(file.path)]);
      entries.delete(file.path); contents.delete(file.path); await emit("delete", file);
    },
    rename: async (file, path) => {
      const oldPath = file.path; const content = contents.get(oldPath);
      entries.delete(oldPath); contents.delete(oldPath); file.path = path;
      entries.set(path, file); contents.set(path, content); await emit("rename", file, oldPath);
    },
  };
  for (const [path, content] of Object.entries(initial)) { entries.set(path, new FileClass(path)); contents.set(path, content); }
  return { vault, contents, entries, trash, emit };
}
