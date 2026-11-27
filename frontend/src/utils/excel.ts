import * as XLSX from 'xlsx';

export function parseExcelFile<T>(
  file: File,
  columnMap: Record<string, keyof T>,
  defaults: T,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

        if (rows.length === 0) {
          reject(new Error('Excel 檔案無資料'));
          return;
        }

        const items = rows.map((row) => {
          const item = { ...defaults };
          for (const [excelCol, fieldName] of Object.entries(columnMap)) {
            if (row[excelCol] !== undefined && row[excelCol] !== null) {
              (item as Record<string, unknown>)[fieldName as string] = row[excelCol];
            }
          }
          return item;
        });

        resolve(items);
      } catch {
        reject(new Error('Excel 解析失敗，請確認檔案格式'));
      }
    };
    reader.onerror = () => reject(new Error('檔案讀取失敗'));
    reader.readAsArrayBuffer(file);
  });
}

export function downloadTemplate(
  headers: string[],
  sampleRows: string[][],
  filename: string,
) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  const colWidths = headers.map((h, i) => {
    const maxLen = Math.max(h.length * 2, ...sampleRows.map(r => String(r[i] || '').length));
    return { wch: Math.max(10, maxLen + 2) };
  });
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '匯入範本');
  XLSX.writeFile(wb, filename);
}
