import { Annotation, Compartment, Extension, EditorState, StateEffect, StateField } from "@codemirror/state";
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
  onStructureChange?(callback: () => void): () => void;
}

/** Everything the editor binding needs from an active connection; null means "not connected". */
export interface ActiveSession {
  awareness: Awareness;
  fileSync: FileSyncLike;
}

export interface EditorBindingDeps {
  getSession: () => ActiveSession | null;
  onActivity?: (path: string | null, line: number, editing: boolean) => void;
  isReadOnlyPath?: (path: string) => boolean;
  onAccessChange?: (callback: () => void) => () => void;
}

const collabCompartment = new Compartment();
const loadSharedContent = Annotation.define<boolean>();
interface BoundEditor { path: string; text: Y.Text; session: ActiveSession }
const setBinding = StateEffect.define<BoundEditor | null>();
const bindingField = StateField.define<BoundEditor | null>({
  create: () => null,
  update: (binding, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setBinding)) binding = effect.value;
    return binding;
  },
});
/** Check for session and shared-text replacement even when the editor is idle. */
const RECONCILE_INTERVAL_MS = 5000;

/**
 * Global CM6 extension: for every editor pane, tracks which file it currently
 * shows (via Obsidian's editorInfoField) and (re)binds the shared Y.Text for
 * that file through y-codemirror.next whenever the shown file (or the active
 * session) changes.
 */
export function createLiveEditExtension(deps: EditorBindingDeps): Extension {
  const accessEffect = StateEffect.define<{ path: string | null; locked: boolean }>();
  const accessField = StateField.define<{ path: string | null; locked: boolean }>({
    create: (state) => {
      const path = state.field(editorInfoField, false)?.file?.path ?? null;
      return { path, locked: !!path && !!deps.isReadOnlyPath?.(path) };
    },
    update: (value, transaction) => {
      for (const effect of transaction.effects) if (effect.is(accessEffect)) value = effect.value;
      return value;
    },
  });
  return [
    accessField,
    EditorState.readOnly.compute([accessField], (state) => state.field(accessField).locked),
    EditorView.editable.compute([accessField], (state) => !state.field(accessField).locked),
    EditorState.transactionFilter.of((transaction) => {
      if (!transaction.docChanged || transaction.annotation(loadSharedContent)) return transaction;
      const path = transaction.state.field(editorInfoField, false)?.file?.path ?? null;
      const oldPath = transaction.startState.field(accessField).path;
      if (path === oldPath && path && deps.isReadOnlyPath?.(path)) return [];
      return transaction;
    }),
    bindingField,
    collabCompartment.of([]),
    EditorState.transactionExtender.of((transaction) => {
      const path = transaction.state.field(editorInfoField, false)?.file?.path ?? null;
      const access = accessEffect.of({ path, locked: !!path && !!deps.isReadOnlyPath?.(path) });
      const binding = transaction.startState.field(bindingField);
      if (!binding) return { effects: access };
      const session = deps.getSession();
      if (path !== binding.path || session !== binding.session ||
          !session?.fileSync.hasText(binding.path) || session.fileSync.getOrCreateText(binding.path) !== binding.text) {
        // Remove ySync before it sees the file-loading transaction. Deferring this
        // until ViewPlugin.update publishes B's buffer as an edit of A.
        return { effects: [access, collabCompartment.reconfigure([]), setBinding.of(null)] };
      }
      return { effects: access };
    }),
    ViewPlugin.fromClass(
      class {
        /** Path the view is currently displaying (may be ahead of `boundPath` while a switch is pending). */
        currentPath: string | null = null;
        /** Session instance last observed — changes across connect/reconnect. */
        lastSeenSession: ActiveSession | null = null;
        /** Path fileSync currently believes is open in this pane. */
        boundPath: string | null = null;
        boundText: Y.Text | null = null;
        bindingRevision = 0;
        requestedSession: ActiveSession | null = null;
        unsubscribeStructure: (() => void) | null = null;
        observedSession: ActiveSession | null = null;
        unsubscribeAccess: (() => void) | null = null;
        accessQueued = false;
        destroyed = false;
        reconcileTimer: number;

        constructor(view: EditorView) {
          this.check(view);
          this.unsubscribeAccess = deps.onAccessChange?.(() => {
            if (this.accessQueued) return;
            this.accessQueued = true;
            queueMicrotask(() => {
              this.accessQueued = false;
              if (!this.destroyed) view.dispatch({});
            });
          }) ?? null;
          // Binding checks never write the buffer back to an old shared text.
          this.reconcileTimer = window.setInterval(() => this.reconcile(view), RECONCILE_INTERVAL_MS);
        }

        update(update: ViewUpdate): void {
          this.check(update.view);
          if (update.view.hasFocus && (update.docChanged || update.selectionSet || update.focusChanged)) {
            const path = update.state.field(editorInfoField, false)?.file?.path ?? null;
            const editing = update.transactions.some((transaction) => transaction.docChanged &&
              ["input", "delete", "undo", "redo"].some((event) => transaction.isUserEvent(event)));
            deps.onActivity?.(path, update.state.doc.lineAt(update.state.selection.main.head).number, editing);
          }
        }

        destroy(): void {
          this.destroyed = true;
          this.unsubscribeStructure?.();
          this.unsubscribeAccess?.();
          window.clearInterval(this.reconcileTimer);
          if (this.boundPath) this.lastSeenSession?.fileSync.markClosed(this.boundPath);
        }

        reconcile(view: EditorView): void {
          this.check(view);
        }

        check(view: EditorView): void {
          if (this.destroyed) return;
          const info = view.state.field(editorInfoField, false);
          const path = info?.file?.path ?? null;
          const session = deps.getSession();
          if (session !== this.observedSession) {
            this.unsubscribeStructure?.();
            this.observedSession = session;
            this.unsubscribeStructure = session?.fileSync.onStructureChange?.(() => this.check(view)) ?? null;
          }
          const expectedText = session && path && session.fileSync.isTracked(path) && session.fileSync.hasText(path)
            ? session.fileSync.getOrCreateText(path) : null;
          if (path === this.currentPath && session === this.requestedSession && expectedText === this.boundText) return;
          this.currentPath = path;
          this.requestedSession = session;
          const revision = ++this.bindingRevision;
          // Defer: dispatching a new transaction from inside update() must not
          // happen synchronously within the same update cycle.
          queueMicrotask(() => {
            if (revision === this.bindingRevision) this.applyBinding(view, path, session);
          });
        }

        applyBinding(view: EditorView, path: string | null, session: ActiveSession | null): void {
          if (this.destroyed || path !== this.currentPath) return;

          if (this.boundPath) {
            this.lastSeenSession?.fileSync.markClosed(this.boundPath);
            this.boundPath = null;
            this.boundText = null;
          }
          this.lastSeenSession = session;

          if (!session || !path || !session.fileSync.isTracked(path) || !session.fileSync.hasText(path)) {
            view.dispatch({ effects: [collabCompartment.reconfigure([]), setBinding.of(null)] });
            return;
          }

          session.fileSync.markOpen(path);
          this.boundPath = path;

          const ytext = session.fileSync.getOrCreateText(path);
          this.boundText = ytext;
          // Detach the previous Y.Text before replacing the buffer on a file switch.
          view.dispatch({ effects: [collabCompartment.reconfigure([]), setBinding.of(null)] });

          const sharedContent = ytext.toString();
          if (view.state.doc.toString() !== sharedContent) {
            view.dispatch({
              annotations: loadSharedContent.of(true),
              changes: { from: 0, to: view.state.doc.length, insert: sharedContent },
            });
          }

          view.dispatch({
            effects: [collabCompartment.reconfigure(yCollab(ytext, session.awareness)), setBinding.of({ path, text: ytext, session })],
          });
        }
      },
    ),
  ];
}
