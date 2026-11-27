import { useState, useEffect, useCallback } from 'react';
import { subcontractPlans, auth, type DocBase, type PagedResponse, type LegalEntity, type Project } from '../api';
import StatusBadge from '../components/StatusBadge';
import ExcelImport from '../components/ExcelImport';
import { parseExcelFile, downloadTemplate } from '../utils/excel';

interface PlanItem {
  workCategory: string;
  description: string;
  estimatedAmount: number;
  vendorType: string;
}

const EMPTY_ITEM: PlanItem = { workCategory: '', description: '', estimatedAmount: 0, vendorType: '專業分包' };
const VENDOR_TYPES = ['專業分包', '勞務分包', '材料供應'];

const PLAN_COL_MAP: Record<string, keyof PlanItem> = {
  '工種': 'workCategory',
  '說明': 'description',
  '概估金額': 'estimatedAmount',
  '廠商類型': 'vendorType',
};

function downloadPlanTemplate() {
  downloadTemplate(
    ['工種', '說明', '概估金額', '廠商類型'],
    [
      ['鋼構', '鋼構主體工程含施工架', '12000000', '專業分包'],
      ['水電', '水電消防工程', '8000000', '專業分包'],
      ['勞務', '一般勞務工', '4000000', '勞務分包'],
    ],
    '分包計畫匯入範本.xlsx',
  );
}

async function importPlanItems(file: File): Promise<PlanItem[]> {
  const rows = await parseExcelFile<PlanItem>(file, PLAN_COL_MAP, { ...EMPTY_ITEM });
  return rows.map(r => ({
    ...r,
    estimatedAmount: Number(r.estimatedAmount) || 0,
    vendorType: VENDOR_TYPES.includes(r.vendorType) ? r.vendorType : '專業分包',
  }));
}

export default function SubcontractPlansPage() {
  const [data, setData] = useState<DocBase[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = projectFilter ? `projectId=${projectFilter}` : '';
    subcontractPlans.list(params).then((r: PagedResponse<DocBase>) => setData(r.data));
  }, [projectFilter]);

  useEffect(load, [load]);
  useEffect(() => { auth.projects().then(setProjects); }, []);

  async function action(id: string, fn: (id: string) => Promise<DocBase>) {
    await fn(id); load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">分包計畫表</h1>
        <div className="flex items-center gap-3">
          <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)}
            className="border rounded px-3 py-2 text-sm">
            <option value="">全部專案</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={() => setShowCreate(true)} className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增分包計畫</button>
        </div>
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
                <td className="p-3">{d.legalEntity?.name || '-'}</td>
                <td className="p-3">{d.title}</td>
                <td className="p-3 text-right">${d.totalAmount.toLocaleString()}</td>
                <td className="p-3"><StatusBadge status={d.status} /></td>
                <td className="p-3 space-x-1">
                  {(d.status === 'DRAFT' || d.status === 'REJECTED') && <button onClick={() => setEditingId(d.id)} className="text-orange-600 hover:underline text-xs">編輯</button>}
                  {d.status === 'DRAFT' && <button onClick={() => action(d.id, subcontractPlans.submit)} className="text-blue-600 hover:underline text-xs">送審</button>}
                  {d.status === 'PENDING' && (
                    <>
                      <button onClick={() => action(d.id, subcontractPlans.approve)} className="text-green-600 hover:underline text-xs">核准</button>
                      <button onClick={() => action(d.id, subcontractPlans.reject)} className="text-red-600 hover:underline text-xs">退回</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-400">無資料</td></tr>}
          </tbody>
        </table>
      </div>
      {showCreate && <CreatePlanModal projects={projects} onClose={() => { setShowCreate(false); load(); }} />}
      {editingId && <EditPlanModal id={editingId} onClose={() => { setEditingId(null); load(); }} />}
    </div>
  );
}

function CreatePlanModal({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [legalEntityId, setLegalEntityId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<PlanItem[]>([{ ...EMPTY_ITEM }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { auth.entities().then(setEntities); }, []);

  const eligibleProjects = projects.filter(p => p.status !== 'DRAFT');
  const totalAmount = items.reduce((sum, it) => sum + (it.estimatedAmount || 0), 0);

  function updateItem(idx: number, field: keyof PlanItem, value: string | number) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  }

  async function handleImport(file: File) {
    try {
      const imported = await importPlanItems(file);
      if (imported.length > 0) setItems(imported);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Excel 匯入失敗');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try {
      await subcontractPlans.create({
        legalEntityId, projectId, title, description,
        items: items.map((it, i) => ({ seq: i + 1, ...it })),
        totalAmount,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">新增分包計畫</h2>
        <p className="text-xs text-gray-500 mb-3">可手動輸入或用 Excel 匯入工項，建立後可在列表點「編輯」修改</p>
        {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">法人</label>
            <select value={legalEntityId} onChange={e => setLegalEntityId(e.target.value)} required
              className="w-full border rounded px-3 py-2 text-sm">
              <option value="">-- 選擇法人 --</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">專案 (需已立案)</label>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} required
              className="w-full border rounded px-3 py-2 text-sm">
              <option value="">-- 選擇專案 --</option>
              {eligibleProjects.map(p => <option key={p.id} value={p.id}>{p.name} [{p.status}]</option>)}
            </select>
          </div>
        </div>
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">標題</label>
          <input value={title} onChange={e => setTitle(e.target.value)} required className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">說明</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} />
        </div>

        <div className="mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700">分包工項</label>
              <ExcelImport onImport={handleImport} onTemplate={downloadPlanTemplate} />
            </div>
            <button type="button" onClick={() => setItems(prev => [...prev, { ...EMPTY_ITEM }])}
              className="text-xs text-blue-600 hover:underline">+ 新增工項</button>
          </div>
          <div className="border rounded overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="p-2 text-left w-24">工種</th>
                  <th className="p-2 text-left">說明</th>
                  <th className="p-2 text-right w-28">概估金額</th>
                  <th className="p-2 text-left w-28">廠商類型</th>
                  <th className="p-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="p-1"><input value={it.workCategory} onChange={e => updateItem(idx, 'workCategory', e.target.value)}
                      placeholder="鋼構" className="w-full border rounded px-2 py-1 text-xs" /></td>
                    <td className="p-1"><input value={it.description} onChange={e => updateItem(idx, 'description', e.target.value)}
                      placeholder="工項說明" className="w-full border rounded px-2 py-1 text-xs" /></td>
                    <td className="p-1"><input type="number" value={it.estimatedAmount || ''} onChange={e => updateItem(idx, 'estimatedAmount', Number(e.target.value))}
                      className="w-full border rounded px-2 py-1 text-xs text-right" /></td>
                    <td className="p-1">
                      <select value={it.vendorType} onChange={e => updateItem(idx, 'vendorType', e.target.value)}
                        className="w-full border rounded px-2 py-1 text-xs">
                        {VENDOR_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </td>
                    <td className="p-1 text-center">
                      {items.length > 1 && <button type="button" onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))}
                        className="text-red-400 hover:text-red-600">x</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50">
                  <td colSpan={2} className="p-2 text-right font-medium">合計</td>
                  <td className="p-2 text-right font-bold">${totalAmount.toLocaleString()}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded text-sm">取消</button>
          <button type="submit" disabled={loading} className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {loading ? '建立中...' : '建立'}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditPlanModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<PlanItem[]>([]);
  const [rowVersion, setRowVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    subcontractPlans.get(id).then((d: DocBase) => {
      setTitle(d.title);
      setDescription((d as unknown as { description?: string }).description || '');
      setItems(JSON.parse(d.items || '[]'));
      setRowVersion(d.rowVersion);
      setFetching(false);
    });
  }, [id]);

  const totalAmount = items.reduce((sum, it) => sum + (it.estimatedAmount || 0), 0);

  function updateItem(idx: number, field: keyof PlanItem, value: string | number) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  }

  async function handleImport(file: File) {
    try {
      const imported = await importPlanItems(file);
      if (imported.length > 0) setItems(imported);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Excel 匯入失敗');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try {
      await subcontractPlans.update(id, {
        rowVersion, title, description,
        items: items.map((it, i) => ({ seq: i + 1, ...it })),
      });
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
      <form onSubmit={handleSubmit} className="bg-white rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">編輯分包計畫</h2>
        {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">標題</label>
          <input value={title} onChange={e => setTitle(e.target.value)} required className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">說明</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} />
        </div>
        <div className="mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700">分包工項</label>
              <ExcelImport onImport={handleImport} onTemplate={downloadPlanTemplate} />
            </div>
            <button type="button" onClick={() => setItems(prev => [...prev, { ...EMPTY_ITEM }])}
              className="text-xs text-blue-600 hover:underline">+ 新增工項</button>
          </div>
          <div className="border rounded overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="p-2 text-left w-24">工種</th>
                  <th className="p-2 text-left">說明</th>
                  <th className="p-2 text-right w-28">概估金額</th>
                  <th className="p-2 text-left w-28">廠商類型</th>
                  <th className="p-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="p-1"><input value={it.workCategory} onChange={e => updateItem(idx, 'workCategory', e.target.value)}
                      className="w-full border rounded px-2 py-1 text-xs" /></td>
                    <td className="p-1"><input value={it.description} onChange={e => updateItem(idx, 'description', e.target.value)}
                      className="w-full border rounded px-2 py-1 text-xs" /></td>
                    <td className="p-1"><input type="number" value={it.estimatedAmount || ''} onChange={e => updateItem(idx, 'estimatedAmount', Number(e.target.value))}
                      className="w-full border rounded px-2 py-1 text-xs text-right" /></td>
                    <td className="p-1">
                      <select value={it.vendorType} onChange={e => updateItem(idx, 'vendorType', e.target.value)}
                        className="w-full border rounded px-2 py-1 text-xs">
                        {VENDOR_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </td>
                    <td className="p-1 text-center">
                      {items.length > 1 && <button type="button" onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))}
                        className="text-red-400 hover:text-red-600">x</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50">
                  <td colSpan={2} className="p-2 text-right font-medium">合計</td>
                  <td className="p-2 text-right font-bold">${totalAmount.toLocaleString()}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded text-sm">取消</button>
          <button type="submit" disabled={loading} className="px-4 py-2 bg-orange-600 text-white rounded text-sm hover:bg-orange-700 disabled:opacity-50">
            {loading ? '儲存中...' : '儲存修改'}
          </button>
        </div>
      </form>
    </div>
  );
}
