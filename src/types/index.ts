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

export interface HwpxExportPlanEntry {
  path: string;
  region: 'body' | 'header' | 'footer';
  paragraphCount: number;
  textSignature?: string;
  paragraphIds?: string[];
}

export interface HwpxExportContext {
  entries: HwpxExportPlanEntry[];
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
  /** Raw HWPX zip data for re-export (preserves structure) */
  rawZipData?: ArrayBuffer;
  /** Parser-derived path/order metadata for structure-preserving HWPX export */
  hwpxExportContext?: HwpxExportContext;
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
