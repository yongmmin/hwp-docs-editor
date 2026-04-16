import { FileText, Download, FolderOpen, Wifi, WifiOff } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { ModelPicker } from './ModelPicker';
import type { OllamaModel } from '../../types';

interface HeaderProps {
  ollamaConnected: boolean;
  ollamaModels: OllamaModel[];
  selectedModel: string | null;
  onSelectModel: (name: string) => void;
  onRefreshModels: () => void;
  onExport?: () => void;
  exportDisabled?: boolean;
}

export function Header({
  ollamaConnected,
  ollamaModels,
  selectedModel,
  onSelectModel,
  onRefreshModels,
  onExport,
  exportDisabled = false,
}: HeaderProps) {
  const { view, fileName, reset } = useDocumentStore();

  return (
    <header className="bg-[#2b579a] text-white flex items-center h-10 px-3 gap-2 shrink-0 select-none">
      {/* 로고 + 앱명 */}
      <div className="flex items-center gap-1.5">
        <FileText className="w-4 h-4 text-white/80" />
        <span className="font-semibold text-sm tracking-tight">Docs Editor</span>
      </div>

      {view === 'editor' && fileName && (
        <>
          <span className="text-white/40 mx-1">|</span>
          <span className="text-sm text-white/70 truncate max-w-[240px]">{fileName}</span>

          <div className="flex-1" />

          {onExport && (
            <HeaderButton onClick={onExport} title="내보내기" disabled={exportDisabled}>
              <Download className="w-3.5 h-3.5" />
              <span>내보내기</span>
            </HeaderButton>
          )}

          <HeaderButton onClick={reset} title="새 파일 열기">
            <FolderOpen className="w-3.5 h-3.5" />
            <span>열기</span>
          </HeaderButton>
        </>
      )}

      {view === 'upload' && <div className="flex-1" />}

      {/* OLLAMA 상태 */}
      <span className="text-white/20 mx-0.5">|</span>
      <div className="flex items-center gap-1.5">
        {ollamaConnected ? (
          <Wifi className="w-3.5 h-3.5 text-green-300" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-red-300" />
        )}

        {ollamaConnected && ollamaModels.length > 0 ? (
          <ModelPicker
            models={ollamaModels}
            selectedModel={selectedModel}
            onSelect={onSelectModel}
            onRefresh={onRefreshModels}
          />
        ) : (
          <span className="text-xs text-white/50">
            {ollamaConnected ? '모델 없음' : 'LLM 미연결'}
          </span>
        )}
      </div>
    </header>
  );
}

function HeaderButton({
  onClick,
  title,
  children,
  disabled = false,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
        disabled ? 'text-white/35 cursor-not-allowed' : 'text-white/80 hover:bg-white/15'
      }`}
    >
      {children}
    </button>
  );
}
