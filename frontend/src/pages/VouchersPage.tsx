import { useState, useEffect, useCallback } from 'react';
import { vouchers } from '../api';
import StatusBadge from '../components/StatusBadge';

interface Voucher {
  id: string; voucherNumber: string; status: string;
  debitAccount: string | null; creditAccount: string | null;
  totalAmount: number; createdAt: string;
  paymentClaim?: { docNumber: string; title: string };
  project?: { name: string };
}

export default function VouchersPage() {
  const [data, setData] = useState<Voucher[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [debit, setDebit] = useState('6100');
  const [credit, setCredit] = useState('2100');

  const load = useCallback(() => {
    vouchers.list().then((r: { data: Voucher[] }) => setData(r.data));
  }, []);
  useEffect(load, [load]);

  async function handleConfirm() {
    if (!confirmId) return;
    await vouchers.confirm(confirmId, { debitAccount: debit, creditAccount: credit });
    setConfirmId(null);
    load();
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">傳票</h1>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-3">傳票號碼</th>
              <th className="text-left p-3">請款單</th>
              <th className="text-left p-3">專案</th>
              <th className="text-right p-3">金額</th>
              <th className="text-left p-3">借方</th>
              <th className="text-left p-3">貸方</th>
              <th className="text-left p-3">狀態</th>
              <th className="text-left p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.map(v => (
              <tr key={v.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{v.voucherNumber}</td>
                <td className="p-3 text-xs">{v.paymentClaim?.docNumber || '-'}</td>
                <td className="p-3 text-xs">{v.project?.name || '-'}</td>
                <td className="p-3 text-right">${v.totalAmount.toLocaleString()}</td>
                <td className="p-3 text-xs">{v.debitAccount || '-'}</td>
                <td className="p-3 text-xs">{v.creditAccount || '-'}</td>
                <td className="p-3"><StatusBadge status={v.status} /></td>
                <td className="p-3">
                  {v.status === 'AUTO_CREATED' && (
                    <button onClick={() => setConfirmId(v.id)} className="text-green-600 hover:underline text-xs">確認</button>
                  )}
                </td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>

      {confirmId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-4">確認傳票</h2>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">借方科目</label>
              <input value={debit} onChange={e => setDebit(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">貸方科目</label>
              <input value={credit} onChange={e => setCredit(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmId(null)} className="px-4 py-2 border rounded text-sm">取消</button>
              <button onClick={handleConfirm} className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700">確認</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
