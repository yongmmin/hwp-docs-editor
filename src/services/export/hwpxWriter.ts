import JSZip from 'jszip';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { JSONContent } from '@tiptap/react';
import type { HwpxExportMeta } from '../../types';

/**
 * HWPX writer — patches section XML inside the original zip in place.
 *
 * 전략: 원본 zip의 섹션 XML 트리를 구조 그대로 유지하고, 편집된 단락의
 * 텍스트만 덮어쓴다. 편집되지 않은 섹션 파일은 건드리지 않는다.
 *
 * 현재 iteration의 스코프:
 *   - 텍스트 편집만 패치 (단락 본문 내 텍스트 변경)
 *   - 단락 수가 원본과 동일한 섹션만 패치 (insert/delete는 다음 이터레이션)
 *   - 단락 수가 다른 섹션은 안전하게 원본 유지
 *   - 컨트롤(표·이미지·도형) 포함 단락은 외부 래퍼만 유지되고, 내부의 `<p>`는
 *     TipTap JSON 순회에서 별도 단락으로 잡힘 → 동일 메커니즘으로 패치됨
 */

type OrderedNode = Record<string, unknown>;
type OrderedNodes = OrderedNode[];

interface EditedParagraph {
  id: string | null;
  text: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  ignoreDeclaration: false,
  trimValues: false,
  parseTagValue: false,
  processEntities: true,
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  suppressEmptyNode: false,
  format: false,
  processEntities: true,
});

export async function writeHwpx(
  json: JSONContent,
  originalZipData: ArrayBuffer,
  meta: HwpxExportMeta | undefined
): Promise<Blob> {
  if (!meta || meta.paragraphs.length === 0) {
    // No metadata → we have nothing to match against. Return original bytes.
    return new Blob([originalZipData], { type: 'application/hwp+zip' });
  }

  const zip = await JSZip.loadAsync(originalZipData);

  const edited = collectEditedParagraphs(json);
  const metaById = new Map(meta.paragraphs.map((p) => [p.id, p]));
  const bySectionPath = groupBySection(edited, metaById, meta.sectionPaths);

  for (const sectionPath of meta.sectionPaths) {
    const editedForSection = bySectionPath.get(sectionPath);
    if (!editedForSection || editedForSection.length === 0) continue;

    const file = zip.file(sectionPath);
    if (!file) continue;

    const xml = await file.async('string');
    const tree = xmlParser.parse(xml) as OrderedNodes;

    const nodes = collectParagraphNodes(tree);

    if (nodes.length !== editedForSection.length) {
      // Structural change — out of current scope. Keep original section bytes.
      console.warn(
        `[hwpxWriter] paragraph count mismatch in ${sectionPath}: ` +
          `xml=${nodes.length} editor=${editedForSection.length}. ` +
          `Section left unchanged. (insert/delete는 다음 이터레이션)`
      );
      continue;
    }

    let dirty = false;
    for (let i = 0; i < nodes.length; i++) {
      const original = nodes[i];
      const next = editedForSection[i];
      const originalText = extractPlainText(original);
      if (originalText === next.text) continue;

      patchParagraphText(original, next.text);
      dirty = true;
    }

    if (dirty) {
      const rebuilt = xmlBuilder.build(tree) as string;
      const declaration = extractXmlDeclaration(xml);
      zip.file(sectionPath, declaration + rebuilt);
    }
  }

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
    mimeType: 'application/hwp+zip',
  });
}

// ─── TipTap JSON traversal ────────────────────────────────────────────────────

function collectEditedParagraphs(json: JSONContent): EditedParagraph[] {
  const out: EditedParagraph[] = [];
  walk(json);
  return out;

  function walk(node: JSONContent | undefined): void {
    if (!node) return;

    if (node.type === 'paragraph' || node.type === 'heading') {
      const id =
        (node.attrs && typeof node.attrs['data-hwp-para-id'] === 'string'
          ? (node.attrs['data-hwp-para-id'] as string)
          : null) ?? null;
      const text = collectText(node);
      // Skip empty paragraphs that exist purely as visual spacers inserted by
      // the editor — they'd desync the count with the original XML.
      // The original parser emits a <p> only when plainText is non-empty.
      if (text.trim() === '' && !id) return;
      out.push({ id, text });
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }

  function collectText(node: JSONContent): string {
    if (node.type === 'text' && typeof node.text === 'string') return node.text;
    if (!Array.isArray(node.content)) return '';
    let s = '';
    for (const child of node.content) s += collectText(child);
    return s;
  }
}

function groupBySection(
  edited: EditedParagraph[],
  metaById: Map<string, HwpxExportMeta['paragraphs'][number]>,
  sectionPaths: string[]
): Map<string, EditedParagraph[]> {
  const groups = new Map<string, EditedParagraph[]>();
  const fallback = sectionPaths[0];
  let currentSection: string | undefined = fallback;

  for (const p of edited) {
    let section: string | undefined;
    if (p.id && metaById.has(p.id)) {
      section = metaById.get(p.id)!.sectionPath;
      currentSection = section;
    } else {
      section = currentSection;
    }
    if (!section) continue;
    const arr = groups.get(section) ?? [];
    arr.push(p);
    groups.set(section, arr);
  }

  return groups;
}

// ─── XML tree traversal (fast-xml-parser preserveOrder format) ───────────────

function collectParagraphNodes(tree: OrderedNodes): OrderedNode[] {
  const out: OrderedNode[] = [];
  visit(tree);
  return out;

  function visit(nodes: OrderedNodes): void {
    for (const node of nodes) {
      const name = getLocalName(node);
      if (!name) continue;
      if (name === 'p' || name === 'para') {
        out.push(node);
      }
      const children = getChildren(node);
      if (children.length > 0) visit(children);
    }
  }
}

function extractPlainText(node: OrderedNode): string {
  let out = '';
  visit(node);
  return out;

  function visit(current: OrderedNode): void {
    if ('#text' in current && typeof current['#text'] !== 'undefined') {
      out += String(current['#text']);
      return;
    }
    const children = getChildren(current);
    for (const child of children) visit(child);
  }
}

/**
 * Put all new text into the first `<t>` element of the paragraph and empty out
 * every subsequent `<t>`. Existing char/paragraph shape references on `<run>`
 * and `<t>` are preserved, so the first run's style absorbs the edited text.
 */
function patchParagraphText(paragraph: OrderedNode, newText: string): void {
  const tNodes: OrderedNode[] = [];
  collectT(getChildren(paragraph), tNodes);

  if (tNodes.length === 0) {
    // Paragraph has no text node — create one inside the first <run>, or
    // create a <run><t/></run> structure if no run exists.
    ensureTextNode(paragraph, newText);
    return;
  }

  setTextOfNode(tNodes[0], newText);
  for (let i = 1; i < tNodes.length; i++) setTextOfNode(tNodes[i], '');

  function collectT(nodes: OrderedNodes, acc: OrderedNode[]): void {
    for (const node of nodes) {
      const name = getLocalName(node);
      if (!name) continue;
      if (name === 't') acc.push(node);
      const children = getChildren(node);
      if (children.length > 0) collectT(children, acc);
    }
  }
}

/**
 * Replace the textual content of a `<t>` node. In fast-xml-parser preserveOrder
 * mode, `<t>hello</t>` is represented as `{ t: [ { '#text': 'hello' } ], ':@': {} }`,
 * or an empty `<t/>` as `{ t: [], ':@': {} }`.
 */
function setTextOfNode(node: OrderedNode, text: string): void {
  const key = getFirstTagKey(node);
  if (!key) return;
  node[key] = [{ '#text': text }];
}

function ensureTextNode(paragraph: OrderedNode, text: string): void {
  const children = getChildren(paragraph);
  // Try to find an existing <run> to attach a new <t> into.
  for (const child of children) {
    const name = getLocalName(child);
    if (name === 'run' || name === 'r') {
      const runChildren = getChildren(child);
      runChildren.push({ t: [{ '#text': text }] });
      return;
    }
  }
  // No <run> — append a synthetic run>t structure to the paragraph itself.
  children.push({ run: [{ t: [{ '#text': text }] }] });
}

// ─── node shape helpers ──────────────────────────────────────────────────────

function getFirstTagKey(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ':@' || key === '#text') continue;
    return key;
  }
  return null;
}

function getLocalName(node: OrderedNode): string | null {
  const key = getFirstTagKey(node);
  if (!key) return null;
  const idx = key.indexOf(':');
  return (idx >= 0 ? key.slice(idx + 1) : key).toLowerCase();
}

function getChildren(node: OrderedNode): OrderedNodes {
  const key = getFirstTagKey(node);
  if (!key) return [];
  const value = node[key];
  return Array.isArray(value) ? (value as OrderedNodes) : [];
}

function extractXmlDeclaration(xml: string): string {
  const match = xml.match(/^\s*<\?xml[^?]*\?>\s*/);
  return match ? match[0] : '';
}

// ─── Meta re-collection (for save-to-buffer) ───────────────────────────────

/**
 * Re-collect HWPX export metadata from a (possibly already-patched) zip buffer.
 * Mirrors the metadata collection in hwpxParser.ts but without generating HTML.
 */
export async function recollectHwpxMeta(zipData: ArrayBuffer): Promise<HwpxExportMeta> {
  const zip = await JSZip.loadAsync(zipData);

  // Discover section XML paths from zip entries.
  const sectionPaths: string[] = [];
  zip.forEach((path) => {
    if (/Contents\/sec(?:tion)?\d+\.xml$/i.test(path)) {
      sectionPaths.push(path);
    }
  });
  sectionPaths.sort();

  const paragraphs: HwpxExportMeta['paragraphs'] = [];

  for (const sectionPath of sectionPaths) {
    const file = zip.file(sectionPath);
    if (!file) continue;
    const xml = await file.async('string');
    const tree = xmlParser.parse(xml) as OrderedNodes;
    const nodes = collectParagraphNodes(tree);

    nodes.forEach((_node, idx) => {
      const id = `${sectionPath}_p${idx}`;
      paragraphs.push({ id, sectionPath, region: 'body', orderInSection: idx });
    });
  }

  return { sectionPaths, paragraphs };
}
