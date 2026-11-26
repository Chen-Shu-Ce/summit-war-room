import { useState, useEffect, useCallback } from 'react';
import { notifications } from '../api';

interface Notification {
  id: string; type: string; title: string; body: string;
  read: boolean; createdAt: string;
}

export default function NotificationsPage() {
  const [data, setData] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const load = useCallback(() => {
    notifications.list().then((r: { data: Notification[]; unreadCount: number }) => {
      setData(r.data as Notification[]);
      setUnreadCount(r.unreadCount);
    });
  }, []);
  useEffect(load, [load]);

  async function markRead(id: string) {
    await notifications.read(id);
    load();
  }

  async function markAllRead() {
    await notifications.readAll();
    load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">
          通知
          {unreadCount > 0 && <span className="ml-2 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">{unreadCount}</span>}
        </h1>
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="text-blue-600 hover:underline text-sm">全部已讀</button>
        )}
      </div>
      <div className="space-y-2">
        {data.map(n => (
          <div key={n.id} className={`bg-white rounded-lg shadow p-4 flex items-start gap-3 ${!n.read ? 'border-l-4 border-blue-500' : ''}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs">{n.type}</span>
                <span className="text-xs text-gray-400">{new Date(n.createdAt).toLocaleString()}</span>
              </div>
              <div className="font-medium text-sm">{n.title}</div>
              <div className="text-sm text-gray-600 mt-0.5">{n.body}</div>
            </div>
            {!n.read && (
              <button onClick={() => markRead(n.id)} className="text-blue-600 hover:underline text-xs whitespace-nowrap">已讀</button>
            )}
          </div>
        ))}
        {data.length === 0 && <div className="text-center text-gray-400 py-8">沒有通知</div>}
      </div>
    </div>
  );
}
