import { useEffect, type CSSProperties } from 'react';
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
  const { document: doc, setEditor } = useDocumentStore();
  const readonlyHwp = doc?.sourceMode === 'hwp-original-readonly';
  const pageStyle = buildPageStyle(doc?.pageLayout);
  const { open: openFindReplace } = useFindReplaceStore();

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

  useEffect(() => {
    if (editor && doc?.html && !readonlyHwp) {
      editor.commands.setContent(doc.html);
    }
  }, [editor, doc?.html, readonlyHwp]);

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
