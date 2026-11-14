import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from './containers/MainLayout';
import DashboardContainer from './containers/DashboardContainer';
import AgentIdentityContainer from './containers/AgentIdentityContainer';
import ConstraintEnforcementContainer from './containers/ConstraintEnforcementContainer';
import KillSwitchContainer from './containers/KillSwitchContainer';
import AnomalyDetectionContainer from './containers/AnomalyDetectionContainer';
import ComplianceContainer from './containers/ComplianceContainer';
import AuditTrailContainer from './containers/AuditTrailContainer';
import Operators from './containers/Operators';
import { connectWebSocket } from './services/websocket';

function App() {
  useEffect(() => {
    connectWebSocket();
    return () => {};
  }, []);

  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
        <Route index element={<DashboardContainer />} />
        <Route path="agents" element={<AgentIdentityContainer />} />
        <Route path="constraints" element={<ConstraintEnforcementContainer />} />
        <Route path="kill-switch" element={<KillSwitchContainer />} />
        <Route path="anomalies" element={<AnomalyDetectionContainer />} />
        <Route path="compliance" element={<ComplianceContainer />} />
        <Route path="audit" element={<AuditTrailContainer />} />
        <Route path="operators" element={<Operators />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;