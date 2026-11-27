import { useState, useEffect, useCallback } from 'react';
import { changeOrders, auth, type LegalEntity, type Project } from '../api';
import StatusBadge from '../components/StatusBadge';

interface CO {
  id: string; docNumber: string; status: string; title: string;
  reason: string; originalAmount: number; changeAmount: number;
  createdAt: string;
  legalEntity?: { name: string }; project?: { name: string };
}

export default function ChangeOrdersPage() {
  const [data, setData] = useState<CO[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({ legalEntityId: '', projectId: '', title: '', reason: '', originalAmount: 0, changeAmount: 0 });
  const [error, setError] = useState('');

  const load = useCallback(() => {
    changeOrders.list().then((r: { data: CO[] }) => setData(r.data));
  }, []);
  useEffect(load, [load]);

  function openCreate() {
    auth.entities().then(setEntities);
    auth.projects().then(setProjects);
    setShowCreate(true);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      await changeOrders.create({ ...form, items: [] });
      setShowCreate(false); setForm({ legalEntityId: '', projectId: '', title: '', reason: '', originalAmount: 0, changeAmount: 0 });
      load();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Error'); }
  }

  async function action(id: string, fn: (id: string) => Promise<unknown>) { await fn(id); load(); }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">變更單</h1>
        <button onClick={openCreate} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增變更單</button>
      </div>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">單號</th>
              <th className="text-left p-3">標題</th>
              <th className="text-left p-3">原因</th>
              <th className="text-left p-3">專案</th>
              <th className="text-right p-3">原金額</th>
              <th className="text-right p-3">變更金額</th>
              <th className="text-left p-3">狀態</th>
              <th className="text-left p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.map(co => (
              <tr key={co.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{co.docNumber}</td>
                <td className="p-3">{co.title}</td>
                <td className="p-3 text-xs text-gray-500">{co.reason}</td>
                <td className="p-3 text-xs">{co.project?.name || '-'}</td>
                <td className="p-3 text-right">${co.originalAmount.toLocaleString()}</td>
                <td className="p-3 text-right font-medium">${co.changeAmount.toLocaleString()}</td>
                <td className="p-3"><StatusBadge status={co.status} /></td>
                <td className="p-3 space-x-1">
                  {co.status === 'ESTIMATING' && <button onClick={() => action(co.id, changeOrders.submit)} className="text-blue-600 hover:underline text-xs">送審</button>}
                  {co.status === 'PENDING' && <button onClick={() => action(co.id, changeOrders.approve)} className="text-green-600 hover:underline text-xs">核准</button>}
                </td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreate} className="bg-white rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-lg font-bold mb-4">新增變更單</h2>
            {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">法人</label>
              <select value={form.legalEntityId} onChange={e => setForm(f => ({ ...f, legalEntityId: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm">
                <option value="">-- 選擇 --</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">專案</label>
              <select value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm">
                <option value="">-- 選擇 --</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">標題</label>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">原因</label>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">原金額</label>
                <input type="number" value={form.originalAmount} onChange={e => setForm(f => ({ ...f, originalAmount: Number(e.target.value) }))} className="w-full border rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">變更金額</label>
                <input type="number" value={form.changeAmount} onChange={e => setForm(f => ({ ...f, changeAmount: Number(e.target.value) }))} className="w-full border rounded px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 border rounded text-sm">取消</button>
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">建立</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
