import { Notice, Vault } from "obsidian";
import { inSharedFolder } from "./shared-scope";

/** Guards Obsidian's public vault operations; the sync engine uses captured originals. */
export class VaultGuard {
  readonly internalVault: Vault;
  private readonly restore: (() => void)[] = [];
  private active = true;

  constructor(vault: Vault, folder: () => string, editable: () => boolean) {
    const target = vault as unknown as Record<string, (...args: any[]) => any>;
    const originals = new Map<string, (...args: any[]) => any>();
    const pathOf = (value: unknown): string => typeof value === "string" ? value :
      typeof value === "object" && value !== null && "path" in value ? String(value.path) : "";
    const affects = (path: string, ancestor = false): boolean => {
      const shared = folder();
      return inSharedFolder(path, shared) || (!!shared && ancestor && shared.startsWith(`${path}/`));
    };
    for (const method of ["create", "createBinary", "createFolder", "modify", "modifyBinary", "append", "process", "delete", "trash", "rename", "copy"]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      originals.set(method, original);
      const wrapped = async (...args: any[]): Promise<any> => {
        const source = pathOf(args[0]);
        const destination = method === "rename" || method === "copy" ? pathOf(args[1]) : "";
        const mutatesSource = method !== "copy";
        if (this.active && !editable() && ((mutatesSource && affects(source, ["delete", "trash", "rename"].includes(method))) || affects(destination))) {
          const message = "LiveEdit: 이 볼트는 연결 및 최신 동기화 완료 후 편집할 수 있습니다. 개인 작업은 다른 볼트를 사용해주세요.";
          new Notice(message);
          throw new Error(message);
        }
        return original.apply(vault, args);
      };
      target[method] = wrapped;
      this.restore.push(() => { if (target[method] === wrapped) target[method] = original; });
    }
    this.internalVault = new Proxy(vault, {
      get(object, property, receiver) {
        const value = typeof property === "string" && originals.has(property) ? originals.get(property) : Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(receiver) : value;
      },
    });
  }

  destroy(): void {
    this.active = false;
    for (const restore of this.restore.reverse()) restore();
  }
}
