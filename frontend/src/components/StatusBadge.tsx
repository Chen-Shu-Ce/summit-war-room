const COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PENDING: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-green-100 text-green-800',
  ISSUED: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CONVERTED: 'bg-purple-100 text-purple-800',
  REJECTED: 'bg-red-100 text-red-800',
  ESTIMATING: 'bg-gray-100 text-gray-700',
  AUTO_CREATED: 'bg-yellow-100 text-yellow-800',
  CONFIRMED: 'bg-green-100 text-green-800',
  NORMAL: 'bg-green-100 text-green-800',
  WARNING: 'bg-yellow-100 text-yellow-800',
  OVER: 'bg-red-100 text-red-800',
};

export default function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${COLORS[status] || 'bg-gray-100 text-gray-700'}`}>{status}</span>;
}
