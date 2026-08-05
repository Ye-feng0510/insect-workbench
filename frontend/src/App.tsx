import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import SettingsPage from './pages/SettingsPage'
import AIWorkbenchPage from './pages/AIWorkbenchPage'
import WorkbenchPage from './pages/WorkbenchPage'
import RecordsPage from './pages/RecordsPage'
import ExportPage from './pages/ExportPage'
import MaterialsPage from './pages/MaterialsPage'
import LoginPage from './pages/LoginPage'
import AdminUsersPage from './pages/AdminUsersPage'
import { PublicOnly, RequireAdmin, RequireAuth } from './components/AuthGuards'

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={(
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        )}
      />
      <Route
        element={(
          <RequireAuth>
            <Layout />
          </RequireAuth>
        )}
      >
        <Route index element={<Navigate to="/agent-workbench" replace />} />
        <Route path="/agent-workbench" element={<AIWorkbenchPage />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/materials" element={<MaterialsPage />} />
        <Route path="/records" element={<RecordsPage />} />
        <Route path="/export" element={<ExportPage />} />
        <Route
          path="/settings"
          element={(
            <RequireAdmin>
              <SettingsPage />
            </RequireAdmin>
          )}
        />
        <Route
          path="/admin/users"
          element={(
            <RequireAdmin>
              <AdminUsersPage />
            </RequireAdmin>
          )}
        />
        <Route path="*" element={<Navigate to="/agent-workbench" replace />} />
      </Route>
    </Routes>
  )
}
