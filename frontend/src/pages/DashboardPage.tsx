import { useState, useEffect } from 'react';
import { auth, reports, budgets, type Project } from '../api';

interface DashData {
  srCount: { total: number; byStatus: Record<string, number> };
  prCount: { total: number; byStatus: Record<string, number> };
  poCount: { total: number; byStatus: Record<string, number> };
  inspectionCount: { total: number; byStatus: Record<string, number> };
  paymentClaimCount: { total: number; byStatus: Record<string, number> };
  totalPOAmount: number;
  totalPaidAmount: number;
  pendingApprovals: number;
}

interface BudgetRow { id: string; category: string; budgetAmount: number; usedAmount: number; executionRate: number; alertLevel: string; }

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState<DashData | null>(null);
  const [budgetData, setBudgetData] = useState<BudgetRow[]>([]);

  useEffect(() => { auth.projects().then(p => { setProjects(p); if (p[0]) setProjectId(p[0].id); }); }, []);

  useEffect(() => {
    const params = projectId ? `projectId=${projectId}` : '';
    reports.dashboard(params).then(d => setData(d as DashData));
    if (projectId) budgets.project(projectId).then(b => setBudgetData(b as BudgetRow[]));
  }, [projectId]);

  const alerts = budgetData.filter(b => b.alertLevel !== 'NORMAL');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">儀表板</h1>
        <select value={projectId} onChange={e => setProjectId(e.target.value)} className="border rounded px-3 py-1.5 text-sm">
          <option value="">全部專案</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <StatCard label="需求單 SR" value={data.srCount.total} sub={`待審 ${data.srCount.byStatus?.PENDING || 0}`} />
            <StatCard label="採購申請 PR" value={data.prCount.total} sub={`待審 ${data.prCount.byStatus?.PENDING || 0}`} />
            <StatCard label="發包單 PO" value={data.poCount.total} sub={`已發包 ${data.poCount.byStatus?.ISSUED || 0}`} />
            <StatCard label="待簽核" value={data.pendingApprovals} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <StatCard label="驗收" value={data.inspectionCount.total} sub={`已完成 ${data.inspectionCount.byStatus?.COMPLETED || 0}`} />
            <StatCard label="請款" value={data.paymentClaimCount.total} sub={`已核准 ${data.paymentClaimCount.byStatus?.APPROVED || 0}`} />
            <StatCard label="PO 總金額" value={`$${data.totalPOAmount.toLocaleString()}`} sub={`已付 $${data.totalPaidAmount.toLocaleString()}`} />
          </div>
        </>
      )}

      {projectId && budgetData.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h2 className="font-bold mb-3">預算執行狀況</h2>
          <div className="space-y-3">
            {budgetData.map(b => (
              <div key={b.id}>
                <div className="flex justify-between text-sm mb-1">
                  <span>{b.category}</span>
                  <span className={b.alertLevel === 'OVER' ? 'text-red-600 font-bold' : b.alertLevel === 'WARNING' ? 'text-yellow-600' : 'text-gray-600'}>
                    {b.executionRate.toFixed(1)}% ({b.alertLevel})
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div className={`h-2.5 rounded-full ${b.alertLevel === 'OVER' ? 'bg-red-500' : b.alertLevel === 'WARNING' ? 'bg-yellow-500' : 'bg-blue-500'}`}
                    style={{ width: `${Math.min(100, b.executionRate)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                  <span>已用 ${b.usedAmount.toLocaleString()}</span>
                  <span>預算 ${b.budgetAmount.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="font-bold text-red-800 mb-2">預算警示</h3>
          {alerts.map(a => (
            <div key={a.id} className="text-sm text-red-700">
              {a.category}: 執行率 {a.executionRate.toFixed(1)}% - {a.alertLevel === 'OVER' ? '已超支' : '接近上限'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
