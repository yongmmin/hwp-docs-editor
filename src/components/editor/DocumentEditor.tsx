import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorToolbar } from './EditorToolbar';
import { SelectionBubbleMenu } from './SelectionBubbleMenu';
import { FindReplaceBar } from './FindReplaceBar';
import { DocumentRegion } from './extensions/DocumentRegion';
import { ImageBlock } from './extensions/ImageBlock';
import { Paragraph } from './extensions/Paragraph';
import { Table, TableCell, TableHeader, TableRow } from './extensions/Table';
import { FindHighlight } from './extensions/FindHighlight';
import { HwpReadonlyViewer } from './HwpReadonlyViewer';
import { useDocumentStore } from '../../stores/documentStore';
import { useWordSuggestion } from '../../hooks/useWordSuggestion';
import { useTextRefinement } from '../../hooks/useTextRefinement';
import { useFindReplaceStore } from '../../stores/findReplaceStore';
import type { PageLayout } from '../../types';

interface DocumentEditorProps {
  ollamaConnected: boolean;
  ollamaModel: string | null;
}

export function DocumentEditor({ ollamaConnected, ollamaModel }: DocumentEditorProps) {
  const { document: doc, setEditor, saveEditorSnapshot } = useDocumentStore();
  const readonlyHwp = doc?.sourceMode === 'hwp-original-readonly';
  const pageStyle = buildPageStyle(doc?.pageLayout);
  const { open: openFindReplace } = useFindReplaceStore();
  const loadedDocRef = useRef<typeof doc>(null);
  const [saveFlash, setSaveFlash] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ paragraph: false }),
      Paragraph,
      Underline,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Table,
      TableRow,
      TableHeader,
      TableCell,
      ImageBlock,
      DocumentRegion,
      FindHighlight,
      Placeholder.configure({
        placeholder: '문서 내용을 편집하세요...',
      }),
    ],
    content: readonlyHwp ? '' : (doc?.html || ''),
    editable: !readonlyHwp,
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
    },
  });

  const { requestSuggestions, applySuggestion } = useWordSuggestion(editor, ollamaModel);
  const { requestRefinement, applyRefinement } = useTextRefinement(editor, ollamaModel);

  // Load the document into the editor only when a *new* document arrives.
  // We intentionally depend on `doc` identity (not `doc.html`) so Cmd+S —
  // which snapshots editor HTML back into the store — does not clobber the
  // live editor state mid-edit.
  useEffect(() => {
    if (!editor || !doc || readonlyHwp) return;
    if (loadedDocRef.current === doc) return;
    editor.commands.setContent(doc.html || '');
    loadedDocRef.current = doc;
  }, [editor, doc, readonlyHwp]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        requestSuggestions();
      }
      if (e.ctrlKey && !e.shiftKey && e.key === 'f') {
        e.preventDefault();
        openFindReplace('find');
      }
      if (e.ctrlKey && e.key === 'h') {
        e.preventDefault();
        openFindReplace('replace');
      }
      // Cmd+S / Ctrl+S — snapshot current editor HTML into the document
      // so subsequent exports operate on the saved state.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 's') {
        e.preventDefault();
        if (saveEditorSnapshot()) {
          setSaveFlash(true);
          window.setTimeout(() => setSaveFlash(false), 1200);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestSuggestions, openFindReplace, saveEditorSnapshot]);

  // Register the editor instance globally so export (triggered from Header
  // via AppShell) can read the current document without a DOM query.
  useEffect(() => {
    setEditor(editor);
    return () => setEditor(null);
  }, [editor, setEditor]);

  return {
    editor,
    applySuggestion,
    requestSuggestions,
    applyRefinement,
    requestRefinement,
    EditorComponent: (
      <div className="flex flex-col h-full overflow-hidden">
        {readonlyHwp ? (
          <HwpReadonlyViewer />
        ) : (
          <>
            <EditorToolbar
              editor={editor}
              onSuggest={requestSuggestions}
              ollamaConnected={ollamaConnected}
            />
            <FindReplaceBar editor={editor} />
            <div className="document-canvas flex-1">
              <div className="document-page" style={pageStyle}>
                {editor && (
                  <SelectionBubbleMenu
                    editor={editor}
                    ollamaConnected={ollamaConnected}
                    ollamaModel={ollamaModel}
                    onRequestRefinement={requestRefinement}
                  />
                )}
                <EditorContent editor={editor} />
              </div>
            </div>
            {saveFlash && (
              <div className="pointer-events-none fixed bottom-6 right-6 z-50 rounded-md bg-black/80 px-3 py-2 text-sm text-white shadow-lg">
                저장됨
              </div>
            )}
          </>
        )}
      </div>
    ),
  };
}

function buildPageStyle(pageLayout?: PageLayout): CSSProperties | undefined {
  if (!pageLayout) return undefined;

  const effectiveTopPaddingPt = (pageLayout.paddingTopPt || 0) + (pageLayout.headerPaddingPt || 0);
  const effectiveBottomPaddingPt = (pageLayout.paddingBottomPt || 0) + (pageLayout.footerPaddingPt || 0);
  const contentMinHeightPt = pageLayout.heightPt
    ? Math.max(1, pageLayout.heightPt - effectiveTopPaddingPt - effectiveBottomPaddingPt)
    : undefined;

  const style: Record<string, string> = {};
  assignPtVar(style, '--page-width', pageLayout.widthPt);
  assignPtVar(style, '--page-height', pageLayout.heightPt);
  assignPtVar(style, '--page-padding-top', effectiveTopPaddingPt);
  assignPtVar(style, '--page-padding-right', pageLayout.paddingRightPt);
  assignPtVar(style, '--page-padding-bottom', effectiveBottomPaddingPt);
  assignPtVar(style, '--page-padding-left', pageLayout.paddingLeftPt);
  assignPtVar(style, '--page-content-min-height', contentMinHeightPt);

  return Object.keys(style).length > 0 ? style as CSSProperties : undefined;
}

function assignPtVar(target: Record<string, string>, name: string, value?: number) {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return;
  target[name] = `${Number(value.toFixed(2))}pt`;
}
