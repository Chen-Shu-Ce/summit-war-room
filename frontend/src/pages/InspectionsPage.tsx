import { useState, useEffect, useCallback } from 'react';
import { inspections, type DocBase, type PagedResponse } from '../api';
import DocTable from '../components/DocTable';
import CreateModal from '../components/CreateModal';

const FIELDS = [
  { name: 'legalEntityId', label: '法人', type: 'entity' as const, required: true },
  { name: 'projectId', label: '專案', type: 'project' as const, required: true },
  { name: 'title', label: '標題', required: true },
  { name: 'totalAmount', label: '金額', type: 'number' as const },
];

export default function InspectionsPage() {
  const [data, setData] = useState<DocBase[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const load = useCallback(() => { inspections.list().then((r: PagedResponse<DocBase>) => setData(r.data)); }, []);
  useEffect(load, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">驗收</h1>
        <button onClick={() => setShowCreate(true)} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增驗收</button>
      </div>
      <div className="bg-white rounded-lg shadow">
        <DocTable docs={data} actions={d => (
          <>
            {d.status === 'PENDING' && <button onClick={async () => { await inspections.complete(d.id); load(); }} className="text-green-600 hover:underline text-xs">完成驗收</button>}
          </>
        )} />
      </div>
      {showCreate && <CreateModal title="新增驗收單" fields={FIELDS} onClose={() => { setShowCreate(false); load(); }}
        onSubmit={d => inspections.create(d).then(() => {})} />}
    </div>
  );
}
