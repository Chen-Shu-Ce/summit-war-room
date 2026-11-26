import { useState, useEffect, useCallback } from 'react';
import { purchaseOrders, type DocBase, type PagedResponse } from '../api';
import DocTable from '../components/DocTable';

export default function PurchaseOrdersPage() {
  const [data, setData] = useState<DocBase[]>([]);
  const load = useCallback(() => { purchaseOrders.list().then((r: PagedResponse<DocBase>) => setData(r.data)); }, []);
  useEffect(load, [load]);

  async function action(id: string, fn: (id: string) => Promise<DocBase>) { await fn(id); load(); }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">發包單 (PO)</h1>
      <div className="bg-white rounded-lg shadow">
        <DocTable docs={data} actions={d => (
          <>
            {d.status === 'DRAFT' && <button onClick={() => action(d.id, purchaseOrders.submit)} className="text-blue-600 hover:underline text-xs">送審</button>}
            {d.status === 'PENDING' && <button onClick={() => action(d.id, purchaseOrders.approve)} className="text-green-600 hover:underline text-xs">核准</button>}
            {d.status === 'APPROVED' && <button onClick={() => action(d.id, purchaseOrders.issue)} className="text-blue-600 hover:underline text-xs">發包</button>}
          </>
        )} />
      </div>
    </div>
  );
}
