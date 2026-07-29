import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import SettingsPage from './pages/SettingsPage'
import WorkbenchPage from './pages/WorkbenchPage'

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center text-gray-400">
      <p className="text-lg">{name} - 待实现</p>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/workbench" replace />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/records" element={<Placeholder name="记录管理" />} />
        <Route path="/export" element={<Placeholder name="Excel 导出" />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/workbench" replace />} />
      </Route>
    </Routes>
  )
}
