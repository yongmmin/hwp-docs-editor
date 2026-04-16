export interface PageLayout {
  widthPt?: number;
  heightPt?: number;
  paddingTopPt?: number;
  paddingRightPt?: number;
  paddingBottomPt?: number;
  paddingLeftPt?: number;
  headerPaddingPt?: number;
  footerPaddingPt?: number;
}

/**
 * Metadata collected by the HWPX parser to enable in-place export.
 * Each paragraph ID maps back to a (sectionPath, byte range) in the
 * original zip's section XML so the writer can replace only the
 * `<hp:p>` block without rebuilding the document.
 */
export interface HwpxExportMeta {
  /** Ordered list of section XML paths inside the zip (body, header, footer) */
  sectionPaths: string[];
  /** paragraph id → { sectionPath, paragraph order index in that section } */
  paragraphs: Array<{
    id: string;
    sectionPath: string;
    region: 'body' | 'header' | 'footer';
    orderInSection: number;
  }>;
}

/**
 * Metadata collected by the HWP5 legacy parser to enable in-place export.
 * Each paragraph maps to a byte range inside a decompressed BodyText
 * section stream so the writer can patch records without rebuilding.
 */
export interface Hwp5ExportMeta {
  /** Per-section streams (e.g. "BodyText/Section0"), in order */
  sections: Array<{
    streamPath: string;
    /** Ordered paragraph byte ranges inside the decompressed stream */
    paragraphs: Array<{
      /** Byte offset of the HWPTAG_PARA_HEADER record, inclusive */
      startOffset: number;
      /** Byte offset just past the final record for this paragraph */
      endOffset: number;
      /** True if this paragraph contains control records (table/image/etc.) */
      hasControls: boolean;
      /** Decoded plaintext of the PARA_TEXT record (for text-based matching). */
      origText: string;
    }>;
  }>;
}

export interface ParsedDocument {
  title: string;
  html: string;
  /** Higher-fidelity read-only HTML (e.g. native converter output) */
  originalViewHtml?: string;
  sourceMode?: 'editable' | 'hwp-original-readonly';
  pageLayout?: PageLayout;
  metadata: DocumentMetadata;
  originalFormat: 'hwp' | 'hwpx';
  /** Raw HWPX zip data for in-place export */
  rawZipData?: ArrayBuffer;
  /** HWPX parser-derived metadata for in-place export */
  hwpxExportMeta?: HwpxExportMeta;
  /** Raw HWP5 binary buffer for in-place export */
  rawHwpBuffer?: ArrayBuffer;
  /** HWP5 parser-derived metadata for in-place export */
  hwp5ExportMeta?: Hwp5ExportMeta;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  date?: string;
  description?: string;
  pageCount?: number;
}

export interface WordSuggestion {
  word: string;
  meaning: string;
}

export interface RefinedText {
  text: string;
  note: string;
}

export interface SuggestionRequest {
  selectedWord: string;
  surroundingText: string;
}

export interface SuggestionResult {
  originalWord: string;
  suggestions: WordSuggestion[];
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaStatus {
  connected: boolean;
  models: OllamaModel[];
  selectedModel: string | null;
}

export type AppView = 'upload' | 'editor';
