import { useRef } from 'react';

interface Props {
  onImport: (file: File) => void;
  onTemplate: () => void;
}

export default function ExcelImport({ onImport, onTemplate }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onImport(file);
      e.target.value = '';
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={() => ref.current?.click()}
        className="text-xs text-green-700 bg-green-50 border border-green-300 rounded px-2 py-0.5 hover:bg-green-100">
        Excel 匯入
      </button>
      <button type="button" onClick={onTemplate}
        className="text-xs text-gray-500 hover:underline">
        下載範本
      </button>
      <input ref={ref} type="file" accept=".xlsx,.xls,.csv" onChange={handleChange} className="hidden" />
    </span>
  );
}
