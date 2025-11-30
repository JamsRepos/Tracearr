import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { Layout } from '@/components/layout/Layout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Login } from '@/pages/Login';
import { Setup } from '@/pages/Setup';
import { Dashboard } from '@/pages/Dashboard';
import { Map } from '@/pages/Map';
import { StatsActivity, StatsLibrary, StatsUsers } from '@/pages/stats';
import { Users } from '@/pages/Users';
import { UserDetail } from '@/pages/UserDetail';
import { Rules } from '@/pages/Rules';
import { Violations } from '@/pages/Violations';
import { Settings } from '@/pages/Settings';
import { NotFound } from '@/pages/NotFound';

export function App() {
  return (
    <>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />

        {/* Protected routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="map" element={<Map />} />

          {/* Stats routes */}
          <Route path="stats" element={<Navigate to="/stats/activity" replace />} />
          <Route path="stats/activity" element={<StatsActivity />} />
          <Route path="stats/library" element={<StatsLibrary />} />
          <Route path="stats/users" element={<StatsUsers />} />

          {/* Other routes */}
          <Route path="users" element={<Users />} />
          <Route path="users/:id" element={<UserDetail />} />
          <Route path="rules" element={<Rules />} />
          <Route path="violations" element={<Violations />} />
          <Route path="settings/*" element={<Settings />} />

          {/* Legacy redirects */}
          <Route path="analytics" element={<Navigate to="/stats/activity" replace />} />
          <Route path="activity" element={<Navigate to="/stats/activity" replace />} />

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}
