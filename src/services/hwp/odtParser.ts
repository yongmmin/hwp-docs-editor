// ODT (OpenDocument Text) content.xml → TipTap-compatible HTML
// Used when HWP is converted via pyhwp's hwp5odt for high-fidelity editable output.

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text:   'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table:  'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  style:  'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo:     'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  draw:   'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  svg:    'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink:  'http://www.w3.org/1999/xlink',
};

interface ParaStyle {
  textAlign?: string;
  marginLeft?: string;
  marginRight?: string;
  marginTop?: string;
  marginBottom?: string;
  textIndent?: string;
  lineHeight?: string;
}

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: string;
}

interface CellStyle {
  paddingLeft?: string;
  paddingRight?: string;
  paddingTop?: string;
  paddingBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  borderTop?: string;
  borderBottom?: string;
  backgroundColor?: string;
  verticalAlign?: string;
}

interface TableStyle {
  width?: string; // CSS width value, e.g. '100%' or '53.74mm'
  align?: 'left' | 'center' | 'right' | 'margins';
  marginLeft?: string;
  marginRight?: string;
}

interface TableColumnStyle {
  width?: string; // raw ODT width, e.g. '42.5mm'
}

interface StyleMaps {
  para: Map<string, ParaStyle>;
  text: Map<string, TextStyle>;
  cell: Map<string, CellStyle>;
  table: Map<string, TableStyle>;
  tableCol: Map<string, TableColumnStyle>;
}

// ─── Style parsing ───────────────────────────────────────────────────────────

function collectStyleElements(doc: Document): StyleMaps {
  const para = new Map<string, ParaStyle>();
  const text = new Map<string, TextStyle>();
  const cell = new Map<string, CellStyle>();
  const table = new Map<string, TableStyle>();
  const tableCol = new Map<string, TableColumnStyle>();

  const containers = [
    doc.getElementsByTagNameNS(NS.office, 'automatic-styles')[0],
    doc.getElementsByTagNameNS(NS.office, 'styles')[0],
    doc.getElementsByTagNameNS(NS.office, 'master-styles')[0],
  ];

  for (const container of containers) {
    if (!container) continue;
    const styleEls = container.getElementsByTagNameNS(NS.style, 'style');
    for (const styleEl of Array.from(styleEls)) {
      const name   = styleEl.getAttributeNS(NS.style, 'name')   || '';
      const family = styleEl.getAttributeNS(NS.style, 'family') || '';
      if (!name) continue;

      if (family === 'paragraph') {
        const props = styleEl.getElementsByTagNameNS(NS.style, 'paragraph-properties')[0];
        if (!props) continue;
        const ps: ParaStyle = {};
        const align = props.getAttributeNS(NS.fo, 'text-align');
        if (align && align !== 'start' && align !== 'left') ps.textAlign = align === 'end' ? 'right' : align;
        const ml = props.getAttributeNS(NS.fo, 'margin-left');
        if (ml && ml !== '0pt' && ml !== '0in' && ml !== '0cm') ps.marginLeft = ml;
        const mr = props.getAttributeNS(NS.fo, 'margin-right');
        if (mr && mr !== '0pt' && mr !== '0in' && mr !== '0cm') ps.marginRight = mr;
        // margin-top/bottom: always capture (including 0) to override browser <p> defaults
        const mt = props.getAttributeNS(NS.fo, 'margin-top');
        if (mt) ps.marginTop = isZeroLength(mt) ? '0' : mt;
        const mb = props.getAttributeNS(NS.fo, 'margin-bottom');
        if (mb) ps.marginBottom = isZeroLength(mb) ? '0' : mb;
        const ti = props.getAttributeNS(NS.fo, 'text-indent');
        if (ti && !isZeroLength(ti)) ps.textIndent = ti;
        const lh = props.getAttributeNS(NS.fo, 'line-height');
        if (lh && lh !== 'normal') ps.lineHeight = lh;
        if (Object.keys(ps).length > 0) para.set(name, ps);

      } else if (family === 'table-cell') {
        const props = styleEl.getElementsByTagNameNS(NS.style, 'table-cell-properties')[0];
        if (!props) continue;
        const cs: CellStyle = {};
        const foAttrs: [keyof CellStyle, string][] = [
          ['paddingLeft',      'padding-left'],
          ['paddingRight',     'padding-right'],
          ['paddingTop',       'padding-top'],
          ['paddingBottom',    'padding-bottom'],
          ['borderLeft',       'border-left'],
          ['borderRight',      'border-right'],
          ['borderTop',        'border-top'],
          ['borderBottom',     'border-bottom'],
          ['backgroundColor',  'background-color'],
        ];
        for (const [key, attr] of foAttrs) {
          const val = props.getAttributeNS(NS.fo, attr);
          if (val) (cs as Record<string, string>)[key] = val;
        }
        // Vertical alignment (HWP default is top; 'automatic' = top)
        const va = props.getAttributeNS(NS.style, 'vertical-align');
        if (va && va !== 'automatic' && va !== 'top') cs.verticalAlign = va;
        if (Object.keys(cs).length > 0) cell.set(name, cs);

      } else if (family === 'text') {
        const props = styleEl.getElementsByTagNameNS(NS.style, 'text-properties')[0];
        if (!props) continue;
        const ts: TextStyle = {};
        if (props.getAttributeNS(NS.fo, 'font-weight') === 'bold') ts.bold = true;
        if (props.getAttributeNS(NS.fo, 'font-style') === 'italic') ts.italic = true;
        // Underline: check both -type and -style (some ODT generators use one or the other)
        const ul = props.getAttributeNS(NS.style, 'text-underline-type');
        const ulStyle = props.getAttributeNS(NS.style, 'text-underline-style');
        if ((ul && ul !== 'none') || (ulStyle && ulStyle !== 'none')) ts.underline = true;
        // Strikethrough: same dual-attribute pattern
        const st = props.getAttributeNS(NS.style, 'text-line-through-type');
        const stStyle = props.getAttributeNS(NS.style, 'text-line-through-style');
        if ((st && st !== 'none') || (stStyle && stStyle !== 'none')) ts.strikethrough = true;
        const fs = props.getAttributeNS(NS.fo, 'font-size');
        // Skip common body-text sizes (8–11pt) that render smaller than browser defaults
        if (fs && !/^([89]|1[0-1])(\.\d)?pt$/.test(fs)) ts.fontSize = fs;
        if (Object.keys(ts).length > 0) text.set(name, ts);

      } else if (family === 'table') {
        const props = styleEl.getElementsByTagNameNS(NS.style, 'table-properties')[0];
        if (!props) continue;
        const tblStyle: TableStyle = {};
        const rawWidth = props.getAttributeNS(NS.style, 'width');
        if (rawWidth) tblStyle.width = tableWidthToCss(rawWidth);
        const rawAlign = props.getAttributeNS(NS.table, 'align');
        if (rawAlign === 'center' || rawAlign === 'left' || rawAlign === 'right' || rawAlign === 'margins') {
          tblStyle.align = rawAlign;
        }
        const tblMl = props.getAttributeNS(NS.fo, 'margin-left');
        if (tblMl && !isZeroLength(tblMl)) tblStyle.marginLeft = tblMl;
        const tblMr = props.getAttributeNS(NS.fo, 'margin-right');
        if (tblMr && !isZeroLength(tblMr)) tblStyle.marginRight = tblMr;
        if (Object.keys(tblStyle).length > 0) table.set(name, tblStyle);
      } else if (family === 'table-column') {
        const props = styleEl.getElementsByTagNameNS(NS.style, 'table-column-properties')[0];
        if (!props) continue;
        const w = props.getAttributeNS(NS.style, 'column-width');
        if (w) tableCol.set(name, { width: w });
      }
    }
  }

  return { para, text, cell, table, tableCol };
}

function isZeroLength(v: string): boolean {
  return v === '0' || v === '0pt' || v === '0mm' || v === '0cm' || v === '0in' || v === '0px';
}

// Convert ODT table width (e.g. "168.84mm") to a CSS value.
// Tables >= 140 mm are considered full-page-width and get width:100%.
function tableWidthToCss(raw: string): string {
  const mm = parseFloat(raw);
  if (!isNaN(mm) && raw.endsWith('mm') && mm >= 140) return '100%';
  return raw; // pass through as-is (browsers understand mm/cm/pt units)
}

// Convert ODT length string to pt (for data-hwp-col-widths which expects pt values).
function lengthToPt(value: string): number {
  const num = parseFloat(value);
  if (isNaN(num)) return -1;
  if (value.endsWith('pt')) return num;
  if (value.endsWith('mm')) return num * 2.83465;
  if (value.endsWith('cm')) return num * 28.3465;
  if (value.endsWith('in')) return num * 72;
  if (value.endsWith('px')) return num * 0.75;
  return -1;
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

function esc(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderChildren(el: Element, styles: StyleMaps, images: Record<string, string>): string {
  let html = '';
  for (const child of Array.from(el.childNodes)) {
    html += renderNode(child, styles, images);
  }
  return html;
}

function renderNode(node: Node, styles: StyleMaps, images: Record<string, string>): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return esc(node.textContent || '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const ns = el.namespaceURI;
  const tag = el.localName;

  if (ns === NS.text) {
    if (tag === 'p' || tag === 'h')  return renderParagraph(el, styles, images);
    if (tag === 'span')              return renderSpan(el, styles, images);
    if (tag === 'tab')               return '&emsp;';
    if (tag === 'line-break')        return '<br/>';
    if (tag === 'soft-page-break')   return '<hr class="hwp-page-break"/>';
    if (tag === 's') {
      const count = Math.max(1, parseInt(el.getAttributeNS(NS.text, 'c') || '1', 10));
      return '&nbsp;'.repeat(count);
    }
    // sequence-decls and other non-content elements → recurse into children
    return renderChildren(el, styles, images);
  }

  if (ns === NS.table) {
    if (tag === 'table') return renderTable(el, styles, images);
    // rows/cells handled inside renderTable
    return '';
  }

  if (ns === NS.draw) {
    if (tag === 'frame') return renderDrawFrame(el, styles, images);
    return '';
  }

  // Default: recurse for unknown elements (handles office:text, etc.)
  return renderChildren(el, styles, images);
}

function renderParagraph(el: Element, styles: StyleMaps, images: Record<string, string>): string {
  const styleName = el.getAttributeNS(NS.text, 'style-name') || '';
  const paraStyle = styles.para.get(styleName);

  const css: string[] = [];
  if (paraStyle?.textAlign)   css.push(`text-align:${paraStyle.textAlign}`);
  if (paraStyle?.marginLeft)  css.push(`margin-left:${paraStyle.marginLeft}`);
  if (paraStyle?.marginRight) css.push(`margin-right:${paraStyle.marginRight}`);
  if (paraStyle?.textIndent)  css.push(`text-indent:${paraStyle.textIndent}`);
  if (paraStyle?.lineHeight)  css.push(`line-height:${paraStyle.lineHeight}`);
  // Always reset browser's default <p> top/bottom margins; HWP always specifies these explicitly.
  css.push(`margin-top:${paraStyle?.marginTop ?? '0'}`);
  css.push(`margin-bottom:${paraStyle?.marginBottom ?? '0'}`);

  const content = renderChildren(el, styles, images);
  return `<p style="${css.join(';')}">${content}</p>`;
}

function renderSpan(el: Element, styles: StyleMaps, images: Record<string, string>): string {
  const styleName = el.getAttributeNS(NS.text, 'style-name') || '';
  const ts = styles.text.get(styleName);
  let content = renderChildren(el, styles, images);
  if (!ts) return content;

  if (ts.fontSize)      content = `<span style="font-size:${ts.fontSize}">${content}</span>`;
  if (ts.strikethrough) content = `<s>${content}</s>`;
  if (ts.underline)     content = `<u>${content}</u>`;
  if (ts.italic)        content = `<em>${content}</em>`;
  if (ts.bold)          content = `<strong>${content}</strong>`;
  return content;
}

function renderDrawFrame(el: Element, _styles: StyleMaps, images: Record<string, string>): string {
  const imageEl = el.getElementsByTagNameNS(NS.draw, 'image')[0];
  if (!imageEl) return '';

  const href = imageEl.getAttributeNS(NS.xlink, 'href') || '';
  const src = images[href] || images[href.replace(/^\.\//, '')];
  if (!src) return '';

  // svg:width/height on draw:frame reflect HWP's authored image size.
  // Preserve them so embedded images render at the original dimensions
  // instead of falling back to the raster's pixel size.
  const style: string[] = [];
  const width = el.getAttributeNS(NS.svg, 'width');
  const height = el.getAttributeNS(NS.svg, 'height');
  if (width) style.push(`width:${width}`);
  if (height) style.push(`height:${height}`);

  const attrs: string[] = [`src="${src}"`];
  if (style.length > 0) attrs.push(`style="${style.join(';')}"`);

  return `<img ${attrs.join(' ')}/>`;
}

function renderTable(tableEl: Element, styles: StyleMaps, images: Record<string, string>): string {
  const styleName = tableEl.getAttributeNS(NS.table, 'style-name') || '';
  const tblStyle = styles.table.get(styleName);
  // Default to width:100% — HWP tables are almost always full content-width.
  // Use the parsed ODT width only when it's narrower (< 140mm).
  const tableWidth = tblStyle?.width ?? '100%';

  // Horizontal positioning: ODT table:align takes precedence, then explicit margins.
  const tableMarginCss: string[] = [];
  if (tblStyle?.align === 'center') {
    tableMarginCss.push('margin-left:auto', 'margin-right:auto');
  } else if (tblStyle?.align === 'right') {
    tableMarginCss.push('margin-left:auto', 'margin-right:0');
  } else {
    if (tblStyle?.marginLeft) tableMarginCss.push(`margin-left:${tblStyle.marginLeft}`);
    if (tblStyle?.marginRight) tableMarginCss.push(`margin-right:${tblStyle.marginRight}`);
  }
  const marginStyleFragment = tableMarginCss.length > 0 ? `;${tableMarginCss.join(';')}` : '';

  // Collect column declarations: try to get actual widths from ODT table-column styles.
  // pyhwp may emit <table:table-column number-columns-repeated="N"/> without a style-name
  // (no width info), in which case we fall back to equal distribution.
  const colWidthsPt: number[] = [];
  const rows: Element[] = [];

  for (const child of Array.from(tableEl.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.namespaceURI !== NS.table) continue;

    if (el.localName === 'table-column') {
      const repeat = parseInt(el.getAttributeNS(NS.table, 'number-columns-repeated') || '1', 10);
      const colStyleName = el.getAttributeNS(NS.table, 'style-name') || '';
      const colStyle = styles.tableCol.get(colStyleName);
      const widthPt = colStyle?.width ? lengthToPt(colStyle.width) : null;
      for (let i = 0; i < repeat; i++) {
        colWidthsPt.push(widthPt ?? -1); // -1 = unknown
      }
    } else if (el.localName === 'table-row') {
      rows.push(el);
    } else if (
      el.localName === 'table-row-group' ||
      el.localName === 'table-header-rows' ||
      el.localName === 'table-rows' ||
      el.localName === 'table-footer-rows'
    ) {
      for (const rowChild of Array.from(el.childNodes)) {
        if (rowChild.nodeType !== Node.ELEMENT_NODE) continue;
        const rowEl = rowChild as Element;
        if (rowEl.namespaceURI === NS.table && rowEl.localName === 'table-row') {
          rows.push(rowEl);
        }
      }
    }
  }

  const totalCols = colWidthsPt.length || inferTableColumnCount(rows);
  const hasActualWidths = colWidthsPt.length > 0 && colWidthsPt.every(w => w > 0);
  const layoutStyle = totalCols > 0 ? ';table-layout:fixed' : '';
  const fragments: string[] = [];
  let pendingRows: string[] = [];

  const flushPendingRows = () => {
    if (pendingRows.length === 0) return;
    fragments.push(openTableMarkup(tableWidth, layoutStyle, marginStyleFragment, totalCols, hasActualWidths, colWidthsPt));
    fragments.push(pendingRows.join(''));
    fragments.push('</tbody></table>');
    pendingRows = [];
  };

  for (const row of rows) {
    const flowHtml = renderUnwrappedFlowRow(row, totalCols, styles, images);
    if (flowHtml !== null) {
      flushPendingRows();
      if (flowHtml) fragments.push(flowHtml);
      continue;
    }
    pendingRows.push(renderTableRow(row, styles, images));
  }

  flushPendingRows();
  return fragments.join('');
}

function renderTableRow(rowEl: Element, styles: StyleMaps, images: Record<string, string>): string {
  let html = '<tr>';

  for (const child of Array.from(rowEl.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.namespaceURI !== NS.table) continue;

    if (el.localName === 'covered-table-cell') continue; // covered by a span

    if (el.localName === 'table-cell') {
      const colSpan = parseInt(el.getAttributeNS(NS.table, 'number-columns-spanned') || '1', 10);
      const rowSpan = parseInt(el.getAttributeNS(NS.table, 'number-rows-spanned') || '1', 10);
      const colRepeat = parseInt(el.getAttributeNS(NS.table, 'number-columns-repeated') || '1', 10);

      const attrs: string[] = [];
      if (colSpan > 1) attrs.push(`colspan="${colSpan}"`);
      if (rowSpan > 1) attrs.push(`rowspan="${rowSpan}"`);

      const cellStyleName = el.getAttributeNS(NS.table, 'style-name') || '';
      const cs = styles.cell.get(cellStyleName);
      const css: string[] = [];
      if (cs) {
        if (cs.paddingLeft)    css.push(`padding-left:${cs.paddingLeft}`);
        if (cs.paddingRight)   css.push(`padding-right:${cs.paddingRight}`);
        if (cs.paddingTop)     css.push(`padding-top:${cs.paddingTop}`);
        if (cs.paddingBottom)  css.push(`padding-bottom:${cs.paddingBottom}`);
        if (cs.borderLeft)     css.push(`border-left:${cs.borderLeft}`);
        if (cs.borderRight)    css.push(`border-right:${cs.borderRight}`);
        if (cs.borderTop)      css.push(`border-top:${cs.borderTop}`);
        if (cs.borderBottom)   css.push(`border-bottom:${cs.borderBottom}`);
        if (cs.backgroundColor) css.push(`background-color:${cs.backgroundColor}`);
        if (cs.verticalAlign)  css.push(`vertical-align:${cs.verticalAlign}`);
      }
      if (css.length > 0) attrs.push(`style="${css.join(';')}"`);

      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
      const content = renderChildren(el, styles, images);

      for (let i = 0; i < colRepeat; i++) {
        html += `<td${attrStr}>${content}</td>`;
      }
    }
  }

  html += '</tr>';
  return html;
}

function openTableMarkup(
  tableWidth: string,
  layoutStyle: string,
  marginStyleFragment: string,
  totalCols: number,
  hasActualWidths: boolean,
  colWidthsPt: number[],
): string {
  // Emit data-hwp-col-widths when we have actual ODT widths so TipTap can build colgroup.
  // The legacy injector in hwpParser.ts will override this with HWP binary widths if available.
  const colWidthsAttr = hasActualWidths
    ? ` data-hwp-col-widths="${colWidthsPt.map(w => w.toFixed(2)).join(',')}"`
    : '';

  let html = `<table style="border-collapse:collapse;width:${tableWidth}${layoutStyle}${marginStyleFragment}"${colWidthsAttr}>`;
  if (totalCols > 0) {
    if (hasActualWidths) {
      html += `<colgroup>${colWidthsPt.map(w => `<col style="width:${w.toFixed(2)}pt"/>`).join('')}</colgroup>`;
    } else {
      const colPct = (100 / totalCols).toFixed(3) + '%';
      html += `<colgroup>${Array(totalCols).fill(`<col style="width:${colPct}"/>`).join('')}</colgroup>`;
    }
  }
  html += '<tbody>';
  return html;
}

function inferTableColumnCount(rows: Element[]): number {
  let maxCols = 0;

  for (const row of rows) {
    let cols = 0;
    for (const child of Array.from(row.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (el.namespaceURI !== NS.table) continue;
      if (el.localName !== 'table-cell' && el.localName !== 'covered-table-cell') continue;

      const repeat = Math.max(1, parseInt(el.getAttributeNS(NS.table, 'number-columns-repeated') || '1', 10));
      const span = Math.max(1, parseInt(el.getAttributeNS(NS.table, 'number-columns-spanned') || '1', 10));
      cols += repeat * span;
    }
    if (cols > maxCols) maxCols = cols;
  }

  return maxCols;
}

function renderUnwrappedFlowRow(
  rowEl: Element,
  totalCols: number,
  styles: StyleMaps,
  images: Record<string, string>,
): string | null {
  const rowChildren = Array.from(rowEl.childNodes).filter((child): child is Element =>
    child.nodeType === Node.ELEMENT_NODE &&
    (child as Element).namespaceURI === NS.table,
  );
  const cells = rowChildren.filter((el) => el.localName === 'table-cell');
  const hasOnlyCoveredCellsBesideMain =
    rowChildren.length === cells.length ||
    rowChildren.every((el) => el.localName === 'table-cell' || el.localName === 'covered-table-cell');

  if (!hasOnlyCoveredCellsBesideMain || cells.length !== 1) return null;

  const cell = cells[0];
  const colRepeat = Math.max(1, parseInt(cell.getAttributeNS(NS.table, 'number-columns-repeated') || '1', 10));
  const colSpan = Math.max(1, parseInt(cell.getAttributeNS(NS.table, 'number-columns-spanned') || '1', 10));
  const rowSpan = Math.max(1, parseInt(cell.getAttributeNS(NS.table, 'number-rows-spanned') || '1', 10));
  const effectiveSpan = colRepeat * colSpan;

  if (colRepeat !== 1 || rowSpan !== 1) return null;
  if (totalCols > 1 && effectiveSpan < totalCols) return null;

  let blockCount = 0;
  let hasNestedTable = false;
  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').trim()) blockCount += 1;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.namespaceURI === NS.table && el.localName === 'table') {
      hasNestedTable = true;
      blockCount += 1;
      continue;
    }
    if (el.namespaceURI === NS.text && (el.localName === 'p' || el.localName === 'h')) {
      blockCount += 1;
    }
  }

  // Unwrap only rows that are effectively document-flow content, not short
  // single-cell tables like titles or compact labels.
  if (!hasNestedTable && blockCount < 2) return null;

  return renderChildren(cell, styles, images).trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function odtContentToHtml(
  contentXml: string,
  stylesXml: string,
  images: Record<string, string>,
): string {
  const parser = new DOMParser();
  const contentDoc = parser.parseFromString(contentXml, 'application/xml');
  const stylesDoc  = parser.parseFromString(stylesXml,  'application/xml');

  const styles = collectStyleElements(contentDoc);
  const stylesFromStylesDoc = collectStyleElements(stylesDoc);

  // named styles from styles.xml fill gaps (content automatic-styles take priority)
  for (const [k, v] of stylesFromStylesDoc.para) {
    if (!styles.para.has(k)) styles.para.set(k, v);
  }
  for (const [k, v] of stylesFromStylesDoc.text) {
    if (!styles.text.has(k)) styles.text.set(k, v);
  }
  for (const [k, v] of stylesFromStylesDoc.cell) {
    if (!styles.cell.has(k)) styles.cell.set(k, v);
  }
  for (const [k, v] of stylesFromStylesDoc.table) {
    if (!styles.table.has(k)) styles.table.set(k, v);
  }
  for (const [k, v] of stylesFromStylesDoc.tableCol) {
    if (!styles.tableCol.has(k)) styles.tableCol.set(k, v);
  }

  const officeText = contentDoc.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!officeText) return '';

  const parts: string[] = [];
  for (const child of Array.from(officeText.childNodes)) {
    parts.push(renderNode(child, styles, images));
  }

  return parts.join('');
}
