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
  const [editingId, setEditingId] = useState<string | null>(null);

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
                  {p.status === 'DRAFT' && <button onClick={() => setEditingId(p.id)} className="text-orange-600 hover:underline text-xs">編輯</button>}
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
      {editingId && <EditProjectModal id={editingId} onClose={() => { setEditingId(null); load(); }} />}
    </div>
  );
}

function EditProjectModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [form, setForm] = useState({ code: '', name: '', clientName: '', location: '', contractAmount: 0, startDate: '', endDate: '', description: '' });
  const [rowVersion, setRowVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    projects.get(id).then((p: Project) => {
      setForm({
        code: p.code, name: p.name,
        clientName: p.clientName || '', location: p.location || '',
        contractAmount: p.contractAmount, startDate: p.startDate || '',
        endDate: p.endDate || '', description: p.description || '',
      });
      setRowVersion(p.rowVersion);
      setFetching(false);
    });
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try {
      await projects.update(id, { rowVersion, ...form });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally { setLoading(false); }
  }

  if (fetching) return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6">載入中...</div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">編輯專案</h2>
        {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">專案代碼</label>
            <input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">專案名稱</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">業主</label>
            <input value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">工地地點</label>
            <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">合約金額</label>
            <input type="number" value={form.contractAmount || ''} onChange={e => setForm(f => ({ ...f, contractAmount: Number(e.target.value) }))} className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">預計開工</label>
            <input value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} placeholder="YYYY-MM" className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">預計完工</label>
            <input value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} placeholder="YYYY-MM" className="w-full border rounded px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">說明</label>
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded text-sm">取消</button>
          <button type="submit" disabled={loading} className="px-4 py-2 bg-orange-600 text-white rounded text-sm hover:bg-orange-700 disabled:opacity-50">
            {loading ? '儲存中...' : '儲存修改'}
          </button>
        </div>
      </form>
    </div>
  );
}
