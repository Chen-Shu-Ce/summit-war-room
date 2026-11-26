import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { auth, type User } from '../api';

export default function LoginPage() {
  const { login, token } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (token) navigate('/', { replace: true }); }, [token, navigate]);
  useEffect(() => { auth.users().then(setUsers).catch(() => {}); }, []);

  const selected = users.find(u => u.email === email);

  async function handleLogin() {
    if (!email) return;
    setLoading(true); setError('');
    try { await login(email); navigate('/', { replace: true }); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Login failed'); }
    finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-1">EPCOS V4</h1>
        <p className="text-gray-500 text-center mb-6 text-sm">工程採購成本控管系統</p>
        {error && <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">{error}</div>}
        <label className="block text-sm font-medium text-gray-700 mb-1">選擇使用者</label>
        <select value={email} onChange={e => setEmail(e.target.value)}
          className="w-full border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">-- 請選擇 --</option>
          {users.map(u => <option key={u.id} value={u.email}>{u.name} ({u.role})</option>)}
        </select>
        {selected && (
          <div className="bg-blue-50 p-3 rounded mb-4 text-sm">
            <div className="font-medium">{selected.name}</div>
            <div className="text-gray-600">角色: {selected.role} | {selected.email}</div>
          </div>
        )}
        <button onClick={handleLogin} disabled={!email || loading}
          className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
          {loading ? '登入中...' : '登入'}
        </button>
      </div>
    </div>
  );
}
