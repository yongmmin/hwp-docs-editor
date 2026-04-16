import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Header } from './Header';
import { FileUploader } from '../upload/FileUploader';
import { DocumentEditor } from '../editor/DocumentEditor';
import { SuggestionPanel } from '../suggestions/SuggestionPanel';
import { RefinementPanel } from '../refinement/RefinementPanel';
import { ConfirmReplaceModal } from '../upload/ConfirmReplaceModal';
import { useDocumentStore } from '../../stores/documentStore';
import { useSuggestionStore } from '../../stores/suggestionStore';
import { useRefinementStore } from '../../stores/refinementStore';
import { useOllama } from '../../hooks/useOllama';
import { useFileUpload } from '../../hooks/useFileUpload';
import { exportDocument } from '../../services/export';
import { downloadBlob, getExportFilename } from '../../utils/file';

export function AppShell() {
  const { view, document: doc, fileName, isLoading, editor, saveEditorSnapshot } = useDocumentStore();
  const { connected, models, selectedModel, selectModel, refresh } = useOllama();
  const { closePanel: closeSuggestion } = useSuggestionStore();
  const { closePanel: closeRefinement } = useRefinementStore();
  const { handleFile } = useFileUpload();
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0 && !isLoading && pendingFile === null) {
        setPendingFile(acceptedFiles[0]);
      }
    },
    [isLoading, pendingFile]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/x-hwp': ['.hwp'],
      'application/hwp+zip': ['.hwpx'],
    },
    multiple: false,
    noClick: true,
    disabled: isLoading,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSuggestion();
        closeRefinement();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSuggestion, closeRefinement]);

  const handleExport = useCallback(async () => {
    if (!doc || !editor) return;
    if (doc.sourceMode === 'hwp-original-readonly') return;

    // Ensure the latest editor state is snapshotted into the document before
    // export, so the download reflects every unsaved keystroke.
    saveEditorSnapshot();
    // Re-read doc from the store after the snapshot so meta + raw buffers
    // travel with the freshly-saved HTML.
    const latestDoc = useDocumentStore.getState().document ?? doc;

    try {
      const { blob, format } = await exportDocument(editor, latestDoc);
      downloadBlob(blob, getExportFilename(fileName, format));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`내보내기에 실패했습니다.\n${message}`);
    }
  }, [doc, editor, fileName, saveEditorSnapshot]);

  if (view === 'upload') {
    return (
      <div className="h-screen flex flex-col bg-[#e8e8e8]">
        <Header
          ollamaConnected={connected}
          ollamaModels={models}
          selectedModel={selectedModel}
          onSelectModel={selectModel}
          onRefreshModels={refresh}
          onExport={handleExport}
        />
        <main className="flex-1 flex items-center justify-center">
          <FileUploader />
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col" {...getRootProps()}>
      <input {...getInputProps()} />
      <Header
        ollamaConnected={connected}
        ollamaModels={models}
        selectedModel={selectedModel}
        onSelectModel={selectModel}
        onRefreshModels={refresh}
        onExport={handleExport}
        exportDisabled={doc?.sourceMode === 'hwp-original-readonly'}
      />
      <div className="flex-1 flex overflow-hidden relative">
        <EditorArea
          ollamaConnected={connected}
          ollamaModel={selectedModel}
        />
        {isDragActive && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-blue-500/10 border-4 border-blue-400 border-dashed pointer-events-none">
            <p className="text-blue-600 font-semibold text-lg bg-white/80 px-4 py-2 rounded-lg">
              여기에 놓으면 파일이 교체됩니다
            </p>
          </div>
        )}
      </div>
      {pendingFile && (
        <ConfirmReplaceModal
          fileName={pendingFile.name}
          onConfirm={() => {
            handleFile(pendingFile);
            setPendingFile(null);
          }}
          onCancel={() => setPendingFile(null)}
        />
      )}
    </div>
  );
}

function EditorArea({
  ollamaConnected,
  ollamaModel,
}: {
  ollamaConnected: boolean;
  ollamaModel: string | null;
}) {
  const { document: doc } = useDocumentStore();
  const { isOpen: isSuggestionOpen } = useSuggestionStore();
  const { isOpen: isRefinementOpen } = useRefinementStore();
  const result = DocumentEditor({ ollamaConnected, ollamaModel });
  const { editor, applySuggestion, applyRefinement, EditorComponent } = result;

  const fullText = editor?.state.doc.textContent || '';
  const readonly = doc?.sourceMode === 'hwp-original-readonly';

  return (
    <>
      <div className="flex-1 overflow-hidden">{EditorComponent}</div>
      {!readonly && isSuggestionOpen && (
        <SuggestionPanel fullText={fullText} onApply={applySuggestion} />
      )}
      {!readonly && isRefinementOpen && (
        <RefinementPanel onApply={applyRefinement} />
      )}
    </>
  );
}
