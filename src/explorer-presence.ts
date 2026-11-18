import type { App } from "obsidian";
import { getParticipants, type Participant, type PresenceSource } from "./presence";

/** Decorate the existing file explorer; never replace its filename or click handlers. */
export class FileExplorerPresence {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private readonly badges = new Set<HTMLElement>();
  private readonly unsubscribe: () => void;
  private readonly timer: number;
  private queued: number | null = null;
  private destroyed = false;

  constructor(private readonly app: App, private readonly source: PresenceSource) {
    this.unsubscribe = source.onConnectionChange(() => this.schedule());
    // Also discover restored/new explorer panes after layout changes.
    this.timer = window.setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  private schedule(): void {
    if (this.destroyed || this.queued !== null) return;
    this.queued = window.setTimeout(() => {
      this.queued = null;
      this.refresh();
    }, 80);
  }

  refresh(): void {
    if (this.destroyed) return;
    const roots = new Set(this.app.workspace.getLeavesOfType("file-explorer")
      .map((leaf) => leaf.view.containerEl));
    for (const [root, observer] of this.observers) {
      if (!roots.has(root)) { observer.disconnect(); this.observers.delete(root); }
    }
    // Release detached decorations when Obsidian rebuilds or closes a tree.
    for (const badge of this.badges) {
      if (![...roots].some((root) => root.contains(badge))) {
        badge.remove(); this.badges.delete(badge);
      }
    }
    const byFile = new Map<string, Participant[]>();
    const connection = this.source.getPresenceConnection();
    if (this.source.getConnectionStatus() === "connected" && connection?.status === "connected") {
      for (const participant of getParticipants(connection.awareness, connection.doc.clientID, connection)) {
        if (!participant.file) continue;
        const list = byFile.get(participant.file) ?? [];
        list.push(participant);
        byFile.set(participant.file, list);
      }
    }
    for (const root of roots) {
      if (!this.observers.has(root)) {
        // Observe only explorer panes, including lazy-rendered and renamed rows.
        const Observer = root.ownerDocument.defaultView!.MutationObserver;
        const observer = new Observer(() => this.schedule());
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-path"] });
        this.observers.set(root, observer);
      }
      for (const row of Array.from(root.querySelectorAll<HTMLElement>(".nav-file-title[data-path]"))) {
        this.decorate(row, byFile.get(row.getAttribute("data-path") ?? "") ?? []);
      }
    }
  }

  private decorate(row: HTMLElement, participants: Participant[]): void {
    let badge = Array.from(row.children).find((child) => child.classList.contains("liveedit-file-presence")) as HTMLElement | undefined;
    if (!participants.length) {
      if (badge) { this.badges.delete(badge); badge.remove(); }
      return;
    }
    const label = participants.map((person) =>
      `${person.name}${person.self ? " (나)" : ""}`,
    ).join("\n");
    const signature = JSON.stringify(participants.map(({ clientId, name, color, self }) =>
      [clientId, name, color, self]));
    if (badge?.dataset.presence === signature) return;
    if (!badge) {
      badge = row.ownerDocument.createElement("span");
      badge.className = "liveedit-file-presence";
      row.append(badge);
      this.badges.add(badge);
    }
    badge.dataset.presence = signature;
    badge.title = label;
    badge.setAttribute("aria-label", label);
    badge.replaceChildren();
    for (const person of participants.slice(0, 2)) {
      const name = row.ownerDocument.createElement("span");
      name.className = "liveedit-file-person";
      name.style.color = person.color;
      name.textContent = `● ${person.name}${person.self ? " (나)" : ""}`;
      badge.append(name);
    }
    if (participants.length > 2) {
      const more = row.ownerDocument.createElement("span");
      more.textContent = `+${participants.length - 2}`;
      badge.append(more);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    window.clearInterval(this.timer);
    if (this.queued !== null) window.clearTimeout(this.queued);
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const badge of this.badges) badge.remove();
    this.badges.clear();
  }
}
