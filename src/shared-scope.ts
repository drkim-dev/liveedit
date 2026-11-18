export function inSharedFolder(path: string, folder: string): boolean {
  if (!path || path.split("/").some((part) => part.startsWith("."))) return false;
  return !folder || path === folder || path.startsWith(`${folder}/`);
}

export function validSharedFolder(folder: string): boolean {
  return !!folder && !/[\\\x00-\x1f:*?"<>|]/.test(folder) &&
    folder.split("/").every((part) => !!part && !part.startsWith(".") && !/[. ]$/.test(part));
}
