import { useDocumentStore } from '../../stores/documentStore';

export function HwpReadonlyViewer() {
  const { document: doc } = useDocumentStore();
  const rawHtml = doc?.originalViewHtml || doc?.html || '<p>원본 내용을 표시할 수 없습니다.</p>';
  const hasFullDocument = /<html[\s>]/i.test(rawHtml);
  const srcDoc = hasFullDocument
    ? rawHtml
    : `<!doctype html><html><head><meta charset="utf-8" /></head><body>${rawHtml}</body></html>`;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-1.5 border-b border-gray-300 bg-amber-50 text-xs text-amber-900 shrink-0">
        HWP 원본 충실도 우선 모드: 현재 문서는 읽기 전용으로 표시됩니다.
      </div>
      <div className="document-canvas flex-1">
        <div className="readonly-page">
          <iframe
            title="HWP Original Readonly View"
            srcDoc={srcDoc}
            className="h-full w-full border-0 bg-white"
          />
        </div>
      </div>
    </div>
  );
}
