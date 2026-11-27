import { useState, useEffect } from 'react';
import { auth, budgets, type Project } from '../api';
import StatusBadge from '../components/StatusBadge';

interface BudgetRow {
  id: string; category: string; budgetAmount: number; usedAmount: number;
  executionRate: number; alertLevel: string;
}

const CATEGORIES = ['MATERIAL', 'EQUIPMENT', 'ENGINEERING', 'LABOR', 'TOTAL'];

export default function BudgetsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState<BudgetRow[]>([]);
  const [showInit, setShowInit] = useState(false);
  const [initAmounts, setInitAmounts] = useState<Record<string, number>>({});

  useEffect(() => { auth.projects().then(p => { setProjects(p); if (p[0]) setProjectId(p[0].id); }); }, []);

  useEffect(() => {
    if (!projectId) return;
    budgets.project(projectId).then(b => setData(b as BudgetRow[]));
  }, [projectId]);

  async function handleInit() {
    const items = Object.entries(initAmounts).filter(([, v]) => v > 0).map(([category, budgetAmount]) => ({ category, budgetAmount }));
    if (items.length === 0) return;
    await budgets.init(projectId, { budgets: items });
    setShowInit(false);
    budgets.project(projectId).then(b => setData(b as BudgetRow[]));
  }

  const totalBudget = data.reduce((s, b) => s + b.budgetAmount, 0);
  const totalUsed = data.reduce((s, b) => s + b.usedAmount, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">預算控管</h1>
        <div className="flex items-center gap-2">
          <select value={projectId} onChange={e => setProjectId(e.target.value)} className="border rounded px-3 py-1.5 text-sm">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={() => setShowInit(true)} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">初始化預算</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">預算總額</div>
          <div className="text-2xl font-bold mt-1">${totalBudget.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">已使用</div>
          <div className="text-2xl font-bold mt-1">${totalUsed.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">整體執行率</div>
          <div className="text-2xl font-bold mt-1">{totalBudget > 0 ? ((totalUsed / totalBudget) * 100).toFixed(1) : 0}%</div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">類別</th>
              <th className="text-right p-3">預算額</th>
              <th className="text-right p-3">已使用</th>
              <th className="text-right p-3">餘額</th>
              <th className="text-right p-3">執行率</th>
              <th className="text-left p-3">警示</th>
            </tr>
          </thead>
          <tbody>
            {data.map(b => (
              <tr key={b.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-medium">{b.category}</td>
                <td className="p-3 text-right">${b.budgetAmount.toLocaleString()}</td>
                <td className="p-3 text-right">${b.usedAmount.toLocaleString()}</td>
                <td className="p-3 text-right">${(b.budgetAmount - b.usedAmount).toLocaleString()}</td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-20 bg-gray-200 rounded-full h-2">
                      <div className={`h-2 rounded-full ${b.alertLevel === 'OVER' ? 'bg-red-500' : b.alertLevel === 'WARNING' ? 'bg-yellow-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(100, b.executionRate)}%` }} />
                    </div>
                    <span>{b.executionRate.toFixed(1)}%</span>
                  </div>
                </td>
                <td className="p-3"><StatusBadge status={b.alertLevel} /></td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-gray-400">尚未初始化預算</td></tr>}
          </tbody>
        </table>
      </div>

      {showInit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">初始化預算</h2>
            {CATEGORIES.map(cat => (
              <div key={cat} className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">{cat}</label>
                <input type="number" value={initAmounts[cat] || ''} onChange={e => setInitAmounts(a => ({ ...a, [cat]: Number(e.target.value) }))}
                  placeholder="預算金額" className="w-full border rounded px-3 py-2 text-sm" />
              </div>
            ))}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowInit(false)} className="px-4 py-2 border rounded text-sm">取消</button>
              <button onClick={handleInit} className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">確認</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
