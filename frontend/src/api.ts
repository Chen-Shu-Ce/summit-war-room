const BASE = '/api/v1';

function getToken(): string | null {
  return localStorage.getItem('token');
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export interface User { id: string; name: string; email: string; role: string; }
export interface LegalEntity { id: string; code: string; name: string; }
export interface Project { id: string; code: string; name: string; legalEntityId: string; legalEntity?: LegalEntity; }

export interface DocBase {
  id: string; docNumber: string; legalEntityId: string; projectId: string;
  createdBy: string; updatedBy: string; status: string; rowVersion: number;
  title: string; items: string; totalAmount: number;
  createdAt: string; updatedAt: string;
  legalEntity?: LegalEntity; project?: Project;
}

export interface PagedResponse<T> { data: T[]; total: number; page: number; pageSize: number; }

export const auth = {
  login: (email: string) => api.post<{ token: string; user: User }>('/auth/login', { email }),
  users: () => api.get<User[]>('/auth/users'),
  entities: () => api.get<LegalEntity[]>('/auth/entities'),
  projects: () => api.get<Project[]>('/auth/projects'),
};

export const siteRequests = {
  list: (params = '') => api.get<PagedResponse<DocBase>>(`/site-requests?${params}`),
  get: (id: string) => api.get<DocBase>(`/site-requests/${id}`),
  create: (data: unknown) => api.post<DocBase>('/site-requests', data),
  update: (id: string, data: unknown) => api.put<DocBase>(`/site-requests/${id}`, data),
  submit: (id: string) => api.post<DocBase>(`/site-requests/${id}/submit`),
  approve: (id: string) => api.post<DocBase>(`/site-requests/${id}/approve`),
  convertPr: (id: string) => api.post<DocBase>(`/site-requests/${id}/convert-pr`),
};

export const purchaseRequests = {
  list: (params = '') => api.get<PagedResponse<DocBase>>(`/purchase-requests?${params}`),
  get: (id: string) => api.get<DocBase>(`/purchase-requests/${id}`),
  create: (data: unknown) => api.post<DocBase>('/purchase-requests', data),
  update: (id: string, data: unknown) => api.put<DocBase>(`/purchase-requests/${id}`, data),
  submit: (id: string) => api.post<DocBase>(`/purchase-requests/${id}/submit`),
  approve: (id: string) => api.post<DocBase>(`/purchase-requests/${id}/approve`),
  reject: (id: string) => api.post<DocBase>(`/purchase-requests/${id}/reject`),
  convertPo: (id: string) => api.post<DocBase>(`/purchase-requests/${id}/convert-po`),
};

export const purchaseOrders = {
  list: (params = '') => api.get<PagedResponse<DocBase>>(`/purchase-orders?${params}`),
  get: (id: string) => api.get<DocBase>(`/purchase-orders/${id}`),
  submit: (id: string) => api.post<DocBase>(`/purchase-orders/${id}/submit`),
  approve: (id: string) => api.post<DocBase>(`/purchase-orders/${id}/approve`),
  issue: (id: string) => api.post<DocBase>(`/purchase-orders/${id}/issue`),
};

export const inspections = {
  list: (params = '') => api.get<PagedResponse<DocBase>>(`/inspections?${params}`),
  get: (id: string) => api.get<DocBase>(`/inspections/${id}`),
  create: (data: unknown) => api.post<DocBase>('/inspections', data),
  complete: (id: string) => api.post<DocBase>(`/inspections/${id}/complete`),
};

export const paymentClaims = {
  list: (params = '') => api.get<PagedResponse<DocBase>>(`/payment-claims?${params}`),
  get: (id: string) => api.get<DocBase>(`/payment-claims/${id}`),
  create: (data: unknown) => api.post<DocBase>('/payment-claims', data),
  submit: (id: string) => api.post<DocBase>(`/payment-claims/${id}/submit`),
  approve: (id: string) => api.post<DocBase>(`/payment-claims/${id}/approve`),
};

export const vouchers = {
  list: (params = '') => api.get<PagedResponse<unknown>>(`/vouchers?${params}`),
  confirm: (id: string, data?: unknown) => api.post(`/vouchers/${id}/confirm`, data),
};

export const budgets = {
  project: (projectId: string) => api.get<unknown[]>(`/budgets/project/${projectId}`),
  init: (projectId: string, data: unknown) => api.post(`/budgets/project/${projectId}/init`, data),
  check: (data: unknown) => api.post(`/budgets/check`, data),
};

export const changeOrders = {
  list: (params = '') => api.get<PagedResponse<unknown>>(`/change-orders?${params}`),
  create: (data: unknown) => api.post('/change-orders', data),
  submit: (id: string) => api.post(`/change-orders/${id}/submit`),
  approve: (id: string) => api.post(`/change-orders/${id}/approve`),
};

export const reports = {
  dashboard: (params = '') => api.get<unknown>(`/reports/dashboard?${params}`),
  projectSummary: (id: string) => api.get<unknown>(`/reports/project/${id}/summary`),
};

export const notifications = {
  list: (params = '') => api.get<{ data: unknown[]; total: number; unreadCount: number }>(`/notifications?${params}`),
  read: (id: string) => api.post(`/notifications/${id}/read`),
  readAll: () => api.post('/notifications/read-all'),
};

export const auditLogs = {
  list: (params = '') => api.get<PagedResponse<unknown>>(`/audit-logs?${params}`),
};

export const ocr = {
  scan: (data: unknown) => api.post(`/ocr/scan`, data),
};

export const unitPrices = {
  list: (params = '') => api.get<PagedResponse<unknown>>(`/unit-prices?${params}`),
  create: (data: unknown) => api.post('/unit-prices', data),
  compare: (data: unknown) => api.post('/unit-prices/compare', data),
};
