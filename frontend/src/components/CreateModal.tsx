import { useState, useEffect } from 'react';
import { auth, type LegalEntity, type Project } from '../api';

interface Field { name: string; label: string; type?: 'text' | 'number' | 'textarea' | 'entity' | 'project'; required?: boolean; }

interface Props {
  title: string;
  fields: Field[];
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

export default function CreateModal({ title, fields, onSubmit, onClose }: Props) {
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (fields.some(f => f.type === 'entity')) auth.entities().then(setEntities);
    if (fields.some(f => f.type === 'project')) auth.projects().then(setProjects);
  }, [fields]);

  const set = (k: string, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try { await onSubmit(form); onClose(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Error'); }
    finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">{title}</h2>
        {error && <div className="bg-red-50 text-red-600 p-2 rounded mb-3 text-sm">{error}</div>}
        {fields.map(f => (
          <div key={f.name} className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
            {f.type === 'entity' ? (
              <select value={(form[f.name] as string) || ''} onChange={e => set(f.name, e.target.value)} required={f.required}
                className="w-full border rounded px-3 py-2 text-sm">
                <option value="">-- 選擇法人 --</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}
              </select>
            ) : f.type === 'project' ? (
              <select value={(form[f.name] as string) || ''} onChange={e => set(f.name, e.target.value)} required={f.required}
                className="w-full border rounded px-3 py-2 text-sm">
                <option value="">-- 選擇專案 --</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea value={(form[f.name] as string) || ''} onChange={e => set(f.name, e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm" rows={3} />
            ) : (
              <input type={f.type || 'text'} value={(form[f.name] as string) ?? ''} onChange={e => set(f.name, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                required={f.required} className="w-full border rounded px-3 py-2 text-sm" />
            )}
          </div>
        ))}
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
