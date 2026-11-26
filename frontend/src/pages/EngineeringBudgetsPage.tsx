import { useState, useEffect, useCallback } from 'react';
import { engineeringBudgets, auth, type DocBase, type LegalEntity, type Project } from '../api';
import StatusBadge from '../components/StatusBadge';

interface BudgetItem {
  seq: number;
  category: string;
  itemName: string;
  specification: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

const CATEGORIES = ['MATERIAL', 'EQUIPMENT', 'ENGINEERING', 'LABOR'];
const CAT_LABELS: Record<string, string> = { MATERIAL: '材料', EQUIPMENT: '機具', ENGINEERING: '工程', LABOR: '勞務' };

function emptyItem(seq: number): BudgetItem {
  return { seq, category: 'MATERIAL', itemName: '', specification: '', unit: '', quantity: 0, unitPrice: 0, amount: 0 };
}

export default function EngineeringBudgetsPage() {
  const [data, setData] = useState<DocBase[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({ legalEntityId: '', projectId: '', title: '', description: '' });
  const [items, setItems] = useState<BudgetItem[]>([emptyItem(1)]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    engineeringBudgets.list().then((r: { data: DocBase[] }) => setData(r.data));
  }, []);
  useEffect(load, [load]);

  function openCreate() {
    auth.entities().then(setEntities);
    auth.projects().then(setProjects);
    setShowCreate(true);
  }

  function updateItem(idx: number, field: keyof BudgetItem, value: string | number) {
    setItems(prev => {
      const next = [...prev];
      const item = { ...next[idx], [field]: value };
      if (field === 'quantity' || field === 'unitPrice') {
        item.amount = item.quantity * item.unitPrice;
      }
      next[idx] = item;
      return next;
    });
  }

  function addItem() {
    setItems(prev => [...prev, emptyItem(prev.length + 1)]);
  }

  function removeItem(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx).map((it, i) => ({ ...it, seq: i + 1 })));
  }

  const totalAmount = items.reduce((s, it) => s + it.amount, 0);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      await engineeringBudgets.create({ ...form, items, totalAmount });
      setShowCreate(false);
      setForm({ legalEntityId: '', projectId: '', title: '', description: '' });
      setItems([emptyItem(1)]);
      load();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Error'); }
  }

  async function action(id: string, fn: (id: string) => Promise<unknown>) {
    try { await fn(id); load(); }
    catch (err: unknown) { alert(err instanceof Error ? err.message : 'Error'); }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">工程預算書</h1>
        <button onClick={openCreate} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增預算書</button>
      </div>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">單號</th>
              <th className="text-left p-3">專案</th>
              <th className="text-left p-3">法人</th>
              <th className="text-left p-3">標題</th>
              <th className="text-right p-3">金額</th>
              <th className="text-left p-3">狀態</th>
              <th className="text-left p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.map(d => (
              <tr key={d.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{d.docNumber}</td>
                <td className="p-3 text-xs">{d.project?.name || '-'}</td>
                <td className="p-3 text-xs">{d.legalEntity?.name || '-'}</td>
                <td className="p-3">{d.title}</td>
                <td className="p-3 text-right">${d.totalAmount.toLocaleString()}</td>
                <td className="p-3"><StatusBadge status={d.status} /></td>
                <td className="p-3 space-x-1">
                  {d.status === 'DRAFT' && <button onClick={() => action(d.id, engineeringBudgets.submit)} className="text-blue-600 hover:underline text-xs">送審</button>}
                  {d.status === 'PENDING' && (
                    <>
                      <button onClick={() => action(d.id, engineeringBudgets.approve)} className="text-green-600 hover:underline text-xs">核准</button>
                      <button onClick={() => action(d.id, engineeringBudgets.reject)} className="text-red-600 hover:underline text-xs">退回</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={handleCreate} className="bg-white rounded-lg p-6 w-full max-w-4xl my-8">
            <h2 className="text-lg font-bold mb-4">新增工程預算書</h2>
            {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">法人</label>
                <select value={form.legalEntityId} onChange={e => setForm(f => ({ ...f, legalEntityId: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm">
                  <option value="">-- 選擇 --</option>
                  {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">專案</label>
                <select value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm">
                  <option value="">-- 選擇 --</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">標題</label>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">說明</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} className="w-full border rounded px-3 py-2 text-sm" />
            </div>

            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-gray-700">預算項目</label>
                <button type="button" onClick={addItem} className="text-xs text-blue-600 hover:underline">+ 新增項目</button>
              </div>
              <div className="border rounded overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="p-2 text-left w-8">#</th>
                      <th className="p-2 text-left">類別</th>
                      <th className="p-2 text-left">品項</th>
                      <th className="p-2 text-left">規格</th>
                      <th className="p-2 text-left w-16">單位</th>
                      <th className="p-2 text-right w-20">數量</th>
                      <th className="p-2 text-right w-24">單價</th>
                      <th className="p-2 text-right w-28">金額</th>
                      <th className="p-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="p-1 text-center text-gray-400">{it.seq}</td>
                        <td className="p-1">
                          <select value={it.category} onChange={e => updateItem(idx, 'category', e.target.value)} className="w-full border rounded px-1 py-1 text-xs">
                            {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
                          </select>
                        </td>
                        <td className="p-1"><input value={it.itemName} onChange={e => updateItem(idx, 'itemName', e.target.value)} className="w-full border rounded px-1 py-1 text-xs" placeholder="品項名稱" /></td>
                        <td className="p-1"><input value={it.specification} onChange={e => updateItem(idx, 'specification', e.target.value)} className="w-full border rounded px-1 py-1 text-xs" placeholder="規格" /></td>
                        <td className="p-1"><input value={it.unit} onChange={e => updateItem(idx, 'unit', e.target.value)} className="w-full border rounded px-1 py-1 text-xs" placeholder="單位" /></td>
                        <td className="p-1"><input type="number" value={it.quantity || ''} onChange={e => updateItem(idx, 'quantity', Number(e.target.value))} className="w-full border rounded px-1 py-1 text-xs text-right" /></td>
                        <td className="p-1"><input type="number" value={it.unitPrice || ''} onChange={e => updateItem(idx, 'unitPrice', Number(e.target.value))} className="w-full border rounded px-1 py-1 text-xs text-right" /></td>
                        <td className="p-1 text-right font-medium">${it.amount.toLocaleString()}</td>
                        <td className="p-1">
                          {items.length > 1 && <button type="button" onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-600">×</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 font-medium">
                      <td colSpan={7} className="p-2 text-right">合計</td>
                      <td className="p-2 text-right">${totalAmount.toLocaleString()}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
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
