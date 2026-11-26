import { useState, useEffect, useCallback } from 'react';
import { projects, auth, type Project, type LegalEntity } from '../api';
import StatusBadge from '../components/StatusBadge';
import CreateModal from '../components/CreateModal';

const FIELDS = [
  { name: 'legalEntityId', label: '法人', type: 'entity' as const, required: true },
  { name: 'code', label: '專案代碼', required: true },
  { name: 'name', label: '專案名稱', required: true },
  { name: 'clientName', label: '業主' },
  { name: 'location', label: '工地地點' },
  { name: 'contractAmount', label: '合約金額', type: 'number' as const },
  { name: 'startDate', label: '預計開工 (YYYY-MM)' },
  { name: 'endDate', label: '預計完工 (YYYY-MM)' },
  { name: 'description', label: '說明', type: 'textarea' as const },
];

export default function ProjectsPage() {
  const [data, setData] = useState<Project[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    projects.list().then(r => setData(r.data));
  }, []);
  useEffect(load, [load]);

  async function action(id: string, fn: (id: string) => Promise<Project>) {
    try { await fn(id); load(); }
    catch (err: unknown) { alert(err instanceof Error ? err.message : 'Error'); }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">專案立案</h1>
        <button onClick={() => setShowCreate(true)} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增專案</button>
      </div>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">專案號</th>
              <th className="text-left p-3">代碼</th>
              <th className="text-left p-3">專案名稱</th>
              <th className="text-left p-3">法人</th>
              <th className="text-left p-3">業主</th>
              <th className="text-right p-3">合約金額</th>
              <th className="text-left p-3">狀態</th>
              <th className="text-left p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.map(p => (
              <tr key={p.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{p.docNumber}</td>
                <td className="p-3 font-mono text-xs">{p.code}</td>
                <td className="p-3">{p.name}</td>
                <td className="p-3">{p.legalEntity?.name || '-'}</td>
                <td className="p-3 text-xs">{p.clientName || '-'}</td>
                <td className="p-3 text-right">${p.contractAmount.toLocaleString()}</td>
                <td className="p-3"><StatusBadge status={p.status} /></td>
                <td className="p-3 space-x-1">
                  {p.status === 'DRAFT' && <button onClick={() => action(p.id, projects.register)} className="text-yellow-600 hover:underline text-xs">立案</button>}
                  {p.status === 'ACTIVE' && <button onClick={() => action(p.id, projects.complete)} className="text-blue-600 hover:underline text-xs">結案</button>}
                </td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>
      {showCreate && <CreateModal title="新增專案" fields={FIELDS} onClose={() => { setShowCreate(false); load(); }}
        onSubmit={d => projects.create(d).then(() => {})} />}
    </div>
  );
}
