import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

const NAV = [
  { label: '儀表板', to: '/' },
  { group: '專案前置' },
  { label: '專案立案', to: '/projects' },
  { label: '分包計畫', to: '/subcontract-plans' },
  { label: '工程預算書', to: '/engineering-budgets' },
  { group: '採購流程' },
  { label: '需求單 SR', to: '/site-requests' },
  { label: '採購申請 PR', to: '/purchase-requests' },
  { label: '發包單 PO', to: '/purchase-orders' },
  { label: '驗收', to: '/inspections' },
  { label: '請款', to: '/payment-claims' },
  { group: '周邊功能' },
  { label: '傳票', to: '/vouchers' },
  { label: '變更單', to: '/change-orders' },
  { label: '預算控管', to: '/budgets' },
  { label: '單價庫', to: '/unit-prices' },
  { group: '系統' },
  { label: '稽核日誌', to: '/audit-logs' },
  { label: '通知', to: '/notifications' },
] as const;

export default function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-screen bg-gray-100">
      {open && <div className="fixed inset-0 bg-black/30 z-30 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed lg:static inset-y-0 left-0 z-40 w-56 bg-gray-900 text-gray-300 flex flex-col transform transition-transform lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="h-14 flex items-center px-4 text-white font-bold text-lg border-b border-gray-700">EPCOS V4</div>
        <nav className="flex-1 overflow-y-auto py-2">
          {NAV.map((item, i) =>
            'group' in item ? (
              <div key={i} className="px-4 pt-4 pb-1 text-xs uppercase tracking-wider text-gray-500">{item.group}</div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setOpen(false)}
                className={({ isActive }) => `block px-4 py-2 text-sm hover:bg-gray-800 hover:text-white ${isActive ? 'bg-gray-800 text-white' : ''}`}>
                {item.label}
              </NavLink>
            )
          )}
        </nav>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b flex items-center justify-between px-4 shrink-0">
          <button className="lg:hidden p-1" onClick={() => setOpen(true)}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div />
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-600">{user?.name}</span>
            <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs">{user?.role}</span>
            <button onClick={logout} className="text-gray-400 hover:text-red-500">登出</button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
