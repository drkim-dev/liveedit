import { Compartment, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

export interface FileSyncLike {
  isTracked(path: string): boolean;
  hasText(path: string): boolean;
  getOrCreateText(path: string): Y.Text;
  markOpen(path: string): void;
  markClosed(path: string): void;
}

/** Everything the editor binding needs from an active connection; null means "not connected". */
export interface ActiveSession {
  awareness: Awareness;
  fileSync: FileSyncLike;
}

export interface EditorBindingDeps {
  getSession: () => ActiveSession | null;
}

const collabCompartment = new Compartment();
/** How often to double-check an unfocused-but-bound editor against the shared doc. */
const RECONCILE_INTERVAL_MS = 5000;

/**
 * Global CM6 extension: for every editor pane, tracks which file it currently
 * shows (via Obsidian's editorInfoField) and (re)binds the shared Y.Text for
 * that file through y-codemirror.next whenever the shown file (or the active
 * session) changes.
 */
export function createLiveEditExtension(deps: EditorBindingDeps): Extension {
  return [
    collabCompartment.of([]),
    ViewPlugin.fromClass(
      class {
        /** Path the view is currently displaying (may be ahead of `boundPath` while a switch is pending). */
        currentPath: string | null = null;
        /** Session instance last observed — changes across connect/reconnect. */
        lastSeenSession: ActiveSession | null = null;
        /** Path fileSync currently believes is open in this pane. */
        boundPath: string | null = null;
        destroyed = false;
        reconcileTimer: number;

        constructor(view: EditorView) {
          this.check(view);
          // Safety net: while this pane isn't focused (so we can't clobber an
          // in-progress keystroke), periodically make sure it still matches the
          // shared doc. Normal typing/remote edits are handled live by yCollab —
          // this only ever does something if that somehow missed an update.
          this.reconcileTimer = window.setInterval(() => this.reconcile(view), RECONCILE_INTERVAL_MS);
        }

        update(update: ViewUpdate): void {
          this.check(update.view);
        }

        destroy(): void {
          this.destroyed = true;
          window.clearInterval(this.reconcileTimer);
          if (this.boundPath) this.lastSeenSession?.fileSync.markClosed(this.boundPath);
        }

        reconcile(view: EditorView): void {
          if (this.destroyed || !this.boundPath || view.hasFocus) return;
          const session = this.lastSeenSession;
          if (!session || !session.fileSync.hasText(this.boundPath)) return;
          const ytext = session.fileSync.getOrCreateText(this.boundPath);
          const sharedContent = ytext.toString();
          if (view.state.doc.toString() !== sharedContent) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: sharedContent },
            });
          }
        }

        check(view: EditorView): void {
          const info = view.state.field(editorInfoField, false);
          const path = info?.file?.path ?? null;
          const session = deps.getSession();
          if (path === this.currentPath && session === this.lastSeenSession) return;
          this.currentPath = path;
          // Defer: dispatching a new transaction from inside update() must not
          // happen synchronously within the same update cycle.
          queueMicrotask(() => this.applyBinding(view, path, session));
        }

        applyBinding(view: EditorView, path: string | null, session: ActiveSession | null): void {
          if (this.destroyed || path !== this.currentPath) return;

          if (this.boundPath && (this.boundPath !== path || session !== this.lastSeenSession)) {
            this.lastSeenSession?.fileSync.markClosed(this.boundPath);
            this.boundPath = null;
          }
          this.lastSeenSession = session;

          if (!session || !path || !session.fileSync.isTracked(path)) {
            view.dispatch({ effects: collabCompartment.reconfigure([]) });
            return;
          }

          session.fileSync.markOpen(path);
          this.boundPath = path;

          const alreadyShared = session.fileSync.hasText(path);
          const ytext = session.fileSync.getOrCreateText(path);

          if (alreadyShared) {
            // The shared doc is authoritative — the editor's current buffer may be a
            // stale snapshot from before this file was last synced (e.g. the user
            // navigated away and back while someone else kept editing it), so force
            // it to match before wiring up live collaboration.
            const sharedContent = ytext.toString();
            if (view.state.doc.toString() !== sharedContent) {
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: sharedContent },
              });
            }
          } else if (view.state.doc.length > 0) {
            // Brand new shared doc — seed it from whatever's already in the editor.
            ytext.insert(0, view.state.doc.toString());
          }

          view.dispatch({
            effects: collabCompartment.reconfigure(yCollab(ytext, session.awareness)),
          });
        }
      },
    ),
  ];
}
