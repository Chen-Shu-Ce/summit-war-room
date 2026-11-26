import { useState, useEffect, useCallback } from 'react';
import { purchaseRequests, type DocBase, type PagedResponse } from '../api';
import DocTable from '../components/DocTable';

export default function PurchaseRequestsPage() {
  const [data, setData] = useState<DocBase[]>([]);
  const load = useCallback(() => { purchaseRequests.list().then((r: PagedResponse<DocBase>) => setData(r.data)); }, []);
  useEffect(load, [load]);

  async function action(id: string, fn: (id: string) => Promise<DocBase>) { await fn(id); load(); }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">採購申請 (PR)</h1>
      <div className="bg-white rounded-lg shadow">
        <DocTable docs={data} actions={d => (
          <>
            {d.status === 'DRAFT' && <button onClick={() => action(d.id, purchaseRequests.submit)} className="text-blue-600 hover:underline text-xs">送審</button>}
            {d.status === 'PENDING' && (
              <>
                <button onClick={() => action(d.id, purchaseRequests.approve)} className="text-green-600 hover:underline text-xs">核准</button>
                <button onClick={() => action(d.id, purchaseRequests.reject)} className="text-red-600 hover:underline text-xs">退回</button>
              </>
            )}
            {d.status === 'APPROVED' && <button onClick={() => action(d.id, purchaseRequests.convertPo)} className="text-purple-600 hover:underline text-xs">轉PO</button>}
          </>
        )} />
      </div>
    </div>
  );
}
