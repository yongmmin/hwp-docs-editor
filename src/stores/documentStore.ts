import { create } from 'zustand';
import type { Editor } from '@tiptap/react';
import type { ParsedDocument, AppView } from '../types';

interface DocumentState {
  view: AppView;
  document: ParsedDocument | null;
  fileName: string | null;
  isLoading: boolean;
  error: string | null;
  originalHtml: string | null;
  /** Active TipTap editor instance — set by EditorArea, used by export. */
  editor: Editor | null;

  setView: (view: AppView) => void;
  setDocument: (doc: ParsedDocument, fileName: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setEditor: (editor: Editor | null) => void;
  /** Snapshot the current editor HTML into document.html (Cmd+S). */
  saveEditorSnapshot: () => boolean;
  reset: () => void;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  view: 'upload',
  document: null,
  fileName: null,
  isLoading: false,
  error: null,
  originalHtml: null,
  editor: null,

  setView: (view) => set({ view }),
  setDocument: (doc, fileName) =>
    set({
      document: doc,
      fileName,
      view: 'editor',
      error: null,
      originalHtml: doc.html,
    }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setEditor: (editor) => set({ editor }),
  saveEditorSnapshot: () => {
    const { editor, document } = get();
    if (!editor || !document) return false;
    const html = editor.getHTML();
    set({ document: { ...document, html } });
    return true;
  },
  reset: () =>
    set({
      view: 'upload',
      document: null,
      fileName: null,
      isLoading: false,
      error: null,
      originalHtml: null,
      editor: null,
    }),
}));
