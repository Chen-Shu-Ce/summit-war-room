import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import SubcontractPlansPage from './pages/SubcontractPlansPage';
import EngineeringBudgetsPage from './pages/EngineeringBudgetsPage';
import SiteRequestsPage from './pages/SiteRequestsPage';
import PurchaseRequestsPage from './pages/PurchaseRequestsPage';
import PurchaseOrdersPage from './pages/PurchaseOrdersPage';
import InspectionsPage from './pages/InspectionsPage';
import PaymentClaimsPage from './pages/PaymentClaimsPage';
import VouchersPage from './pages/VouchersPage';
import ChangeOrdersPage from './pages/ChangeOrdersPage';
import BudgetsPage from './pages/BudgetsPage';
import UnitPricesPage from './pages/UnitPricesPage';
import AuditLogsPage from './pages/AuditLogsPage';
import NotificationsPage from './pages/NotificationsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<DashboardPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="subcontract-plans" element={<SubcontractPlansPage />} />
            <Route path="engineering-budgets" element={<EngineeringBudgetsPage />} />
            <Route path="site-requests" element={<SiteRequestsPage />} />
            <Route path="purchase-requests" element={<PurchaseRequestsPage />} />
            <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
            <Route path="inspections" element={<InspectionsPage />} />
            <Route path="payment-claims" element={<PaymentClaimsPage />} />
            <Route path="vouchers" element={<VouchersPage />} />
            <Route path="change-orders" element={<ChangeOrdersPage />} />
            <Route path="budgets" element={<BudgetsPage />} />
            <Route path="unit-prices" element={<UnitPricesPage />} />
            <Route path="audit-logs" element={<AuditLogsPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
