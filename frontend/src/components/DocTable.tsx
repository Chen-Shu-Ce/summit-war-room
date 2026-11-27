import StatusBadge from './StatusBadge';
import type { DocBase } from '../api';

interface Props {
  docs: DocBase[];
  actions?: (doc: DocBase) => React.ReactNode;
}

export default function DocTable({ docs, actions }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50">
            <th className="text-left p-3">單號</th>
            <th className="text-left p-3">標題</th>
            <th className="text-left p-3">法人</th>
            <th className="text-left p-3">專案</th>
            <th className="text-right p-3">金額</th>
            <th className="text-left p-3">狀態</th>
            <th className="text-left p-3">操作</th>
          </tr>
        </thead>
        <tbody>
          {docs.map(d => (
            <tr key={d.id} className="border-b hover:bg-gray-50">
              <td className="p-3 font-mono text-xs">{d.docNumber}</td>
              <td className="p-3">{d.title}</td>
              <td className="p-3">{d.legalEntity?.name || '-'}</td>
              <td className="p-3 text-xs">{d.project?.name || '-'}</td>
              <td className="p-3 text-right">${d.totalAmount.toLocaleString()}</td>
              <td className="p-3"><StatusBadge status={d.status} /></td>
              <td className="p-3 space-x-1">{actions?.(d)}</td>
            </tr>
          ))}
          {docs.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-400">無資料</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
