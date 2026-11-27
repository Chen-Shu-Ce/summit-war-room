import { useState, useEffect, useCallback } from 'react';
import { unitPrices } from '../api';
import StatusBadge from '../components/StatusBadge';

interface UPRecord {
  id: string; itemName: string; category: string; unit: string;
  unitPrice: number; vendor: string; source: string; recordDate: string;
}

export default function UnitPricesPage() {
  const [data, setData] = useState<UPRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [form, setForm] = useState({ itemName: '', category: 'MATERIAL', unit: '', unitPrice: 0, vendor: '', source: 'MANUAL' });
  const [cmpForm, setCmpForm] = useState({ itemName: '', category: 'MATERIAL', quotedPrice: 0 });
  const [cmpResult, setCmpResult] = useState<{ assessment: string; avgPrice: number; quotedPrice: number } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    unitPrices.list().then((r: { data: UPRecord[] }) => setData(r.data));
  }, []);
  useEffect(load, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try { await unitPrices.create(form); setShowCreate(false); load(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Error'); }
  }

  async function handleCompare(e: React.FormEvent) {
    e.preventDefault();
    const r = await unitPrices.compare(cmpForm) as { assessment: string; avgPrice: number; quotedPrice: number };
    setCmpResult(r);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">單價資料庫</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCompare(true)} className="border border-blue-600 text-blue-600 px-4 py-2 rounded text-sm hover:bg-blue-50">比價</button>
          <button onClick={() => setShowCreate(true)} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增單價</button>
        </div>
      </div>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">品項</th>
              <th className="text-left p-3">類別</th>
              <th className="text-left p-3">單位</th>
              <th className="text-right p-3">單價</th>
              <th className="text-left p-3">廠商</th>
              <th className="text-left p-3">來源</th>
              <th className="text-left p-3">日期</th>
            </tr>
          </thead>
          <tbody>
            {data.map(u => (
              <tr key={u.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-medium">{u.itemName}</td>
                <td className="p-3 text-xs">{u.category}</td>
                <td className="p-3">{u.unit}</td>
                <td className="p-3 text-right">${u.unitPrice.toLocaleString()}</td>
                <td className="p-3 text-xs">{u.vendor}</td>
                <td className="p-3 text-xs">{u.source}</td>
                <td className="p-3 text-xs">{new Date(u.recordDate).toLocaleDateString()}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreate} className="bg-white rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-lg font-bold mb-4">新增單價記錄</h2>
            {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">品項名稱</label>
              <input value={form.itemName} onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">類別</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm">
                  {['MATERIAL', 'EQUIPMENT', 'ENGINEERING', 'LABOR'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">單位</label>
                <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">單價</label>
                <input type="number" value={form.unitPrice} onChange={e => setForm(f => ({ ...f, unitPrice: Number(e.target.value) }))} required className="w-full border rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">廠商</label>
                <input value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 border rounded text-sm">取消</button>
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">建立</button>
            </div>
          </form>
        </div>
      )}

      {showCompare && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">單價比較</h2>
            <form onSubmit={handleCompare}>
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">品項名稱</label>
                <input value={cmpForm.itemName} onChange={e => setCmpForm(f => ({ ...f, itemName: e.target.value }))} required className="w-full border rounded px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">類別</label>
                  <select value={cmpForm.category} onChange={e => setCmpForm(f => ({ ...f, category: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm">
                    {['MATERIAL', 'EQUIPMENT', 'ENGINEERING', 'LABOR'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">報價</label>
                  <input type="number" value={cmpForm.quotedPrice} onChange={e => setCmpForm(f => ({ ...f, quotedPrice: Number(e.target.value) }))} required className="w-full border rounded px-3 py-2 text-sm" />
                </div>
              </div>
              <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded text-sm hover:bg-blue-700 mb-3">比較</button>
            </form>
            {cmpResult && (
              <div className="bg-gray-50 p-3 rounded text-sm">
                <div className="flex justify-between mb-1"><span>歷史均價:</span><span className="font-medium">${cmpResult.avgPrice.toLocaleString()}</span></div>
                <div className="flex justify-between mb-1"><span>報價:</span><span className="font-medium">${cmpResult.quotedPrice.toLocaleString()}</span></div>
                <div className="flex justify-between"><span>評估:</span><StatusBadge status={cmpResult.assessment} /></div>
              </div>
            )}
            <button onClick={() => { setShowCompare(false); setCmpResult(null); }} className="w-full mt-3 px-4 py-2 border rounded text-sm">關閉</button>
          </div>
        </div>
      )}
    </div>
  );
}
