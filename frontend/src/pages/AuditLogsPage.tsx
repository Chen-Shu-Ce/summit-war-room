import { useState, useEffect } from 'react';
import { auditLogs } from '../api';

interface AuditRow {
  id: string; resource: string; action: string; resourceId: string;
  actorId: string; detail: string; ipAddress: string; createdAt: string;
}

export default function AuditLogsPage() {
  const [data, setData] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [resource, setResource] = useState('');
  const [action, setAction] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', '20');
    if (resource) params.set('resource', resource);
    if (action) params.set('action', action);
    auditLogs.list(params.toString()).then((r: { data: AuditRow[]; total: number }) => {
      setData(r.data);
      setTotal(r.total);
    });
  }, [page, resource, action]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">稽核日誌</h1>
      <div className="flex gap-2 mb-4">
        <select value={resource} onChange={e => { setResource(e.target.value); setPage(1); }} className="border rounded px-3 py-1.5 text-sm">
          <option value="">全部資源</option>
          {['site-requests', 'purchase-requests', 'purchase-orders', 'inspections', 'payment-claims', 'vouchers', 'change-orders', 'budgets', 'notifications', 'unit-prices'].map(r =>
            <option key={r} value={r}>{r}</option>
          )}
        </select>
        <select value={action} onChange={e => { setAction(e.target.value); setPage(1); }} className="border rounded px-3 py-1.5 text-sm">
          <option value="">全部操作</option>
          {['CREATE', 'UPDATE', 'SUBMIT', 'APPROVE', 'REJECT', 'CONFIRM'].map(a =>
            <option key={a} value={a}>{a}</option>
          )}
        </select>
        <span className="text-sm text-gray-500 flex items-center">共 {total} 筆</span>
      </div>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">時間</th>
              <th className="text-left p-3">資源</th>
              <th className="text-left p-3">操作</th>
              <th className="text-left p-3">資源ID</th>
              <th className="text-left p-3">操作人</th>
              <th className="text-left p-3">IP</th>
            </tr>
          </thead>
          <tbody>
            {data.map(log => (
              <tr key={log.id} className="border-b hover:bg-gray-50">
                <td className="p-3 text-xs whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                <td className="p-3 text-xs">{log.resource}</td>
                <td className="p-3"><span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs">{log.action}</span></td>
                <td className="p-3 font-mono text-xs">{log.resourceId?.slice(0, 12)}...</td>
                <td className="p-3 text-xs">{log.actorId?.slice(0, 12)}...</td>
                <td className="p-3 text-xs text-gray-400">{log.ipAddress}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border rounded text-sm disabled:opacity-50">上一頁</button>
          <span className="px-3 py-1 text-sm text-gray-600">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1 border rounded text-sm disabled:opacity-50">下一頁</button>
        </div>
      )}
    </div>
  );
}
