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
import { PageBreak } from './extensions/PageBreak';
import { Table, TableCell, TableHeader, TableRow } from './extensions/Table';
import { FindHighlight } from './extensions/FindHighlight';
import { HwpReadonlyViewer } from './HwpReadonlyViewer';
import { usePageBreaks, PAGE_GAP_PX } from './usePageBreaks';
import { useDocumentStore } from '../../stores/documentStore';
import { useWordSuggestion } from '../../hooks/useWordSuggestion';
import { useTextRefinement } from '../../hooks/useTextRefinement';
import { useFindReplaceStore } from '../../stores/findReplaceStore';
import { saveDocumentInPlace } from '../../services/export';
import type { PageLayout } from '../../types';

interface DocumentEditorProps {
  ollamaConnected: boolean;
  ollamaModel: string | null;
}

export function DocumentEditor({ ollamaConnected, ollamaModel }: DocumentEditorProps) {
  const { document: doc, setEditor } = useDocumentStore();
  const readonlyHwp = doc?.sourceMode === 'hwp-original-readonly';
  const pageStyle = buildPageStyle(doc?.pageLayout);
  const { open: openFindReplace } = useFindReplaceStore();
  const loadedDocRef = useRef<typeof doc>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const savingRef = useRef(false);
  const pageRef = useRef<HTMLDivElement>(null);

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
      PageBreak,
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

  const { gaps, totalPages, pageHeightPx } = usePageBreaks(pageRef, [doc, readonlyHwp]);

  const pageTops: number[] = [];
  for (let i = 0; i < totalPages; i += 1) {
    if (i === 0) {
      pageTops.push(0);
      continue;
    }
    const priorGap = gaps[i - 1];
    if (priorGap) {
      pageTops.push(priorGap.y + priorGap.height);
      continue;
    }
    const prevTop = pageTops[i - 1] ?? 0;
    pageTops.push(prevTop + pageHeightPx + PAGE_GAP_PX);
  }

  const stackMinHeightPx =
    pageTops.length > 0 && pageHeightPx > 0
      ? pageTops[pageTops.length - 1] + pageHeightPx
      : undefined;

  const { requestSuggestions, applySuggestion } = useWordSuggestion(editor, ollamaModel);
  const { requestRefinement, applyRefinement } = useTextRefinement(editor, ollamaModel);

  // Load the document into the editor only on initial mount or when a truly
  // new file is opened (not when save updates the store's doc reference).
  useEffect(() => {
    if (!editor || !doc || readonlyHwp) return;
    // After save, we update the store's document (new reference) but the
    // editor already has the correct content. Skip the reset.
    if (savingRef.current) {
      savingRef.current = false;
      loadedDocRef.current = doc;
      return;
    }
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
      // Cmd+S / Ctrl+S — save edits into the document's in-memory binary
      // buffer so the "loaded file" reflects changes, not just exports.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 's') {
        e.preventDefault();
        const currentEditor = useDocumentStore.getState().editor;
        const currentDoc = useDocumentStore.getState().document;
        if (!currentEditor || !currentDoc || savingRef.current) return;
        savingRef.current = true;
        setSaveFlash(true);
        saveDocumentInPlace(currentEditor, currentDoc)
          .then((fields) => {
            useDocumentStore.getState().updateDocument(fields);
          })
          .catch((err) => {
            console.warn('[save] 저장 실패:', err);
            savingRef.current = false;
          })
          .finally(() => {
            window.setTimeout(() => setSaveFlash(false), 1200);
          });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestSuggestions, openFindReplace]);

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
              <div
                className="pages-stack"
                style={{
                  ...pageStyle,
                  ...(stackMinHeightPx ? { minHeight: `${stackMinHeightPx}px` } : null),
                }}
              >
                {Array.from({ length: totalPages }, (_, i) => (
                  <div
                    key={i}
                    className="page-frame"
                    style={{
                      top:
                        pageHeightPx > 0
                          ? `${pageTops[i] ?? i * (pageHeightPx + PAGE_GAP_PX)}px`
                          : i === 0 ? 0 : undefined,
                      height:
                        pageHeightPx > 0 ? `${pageHeightPx}px` : 'var(--page-height)',
                    }}
                    aria-hidden="true"
                  />
                ))}
                <div className="editor-layer" ref={pageRef}>
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
