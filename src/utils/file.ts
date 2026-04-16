export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function getExportFilename(
  originalFilename: string | null,
  format: 'hwp' | 'hwpx'
): string {
  if (!originalFilename) return `document.${format}`;

  const base = originalFilename.replace(/\.(hwp|hwpx)$/i, '');
  return `${base}_편집됨.${format}`;
}
