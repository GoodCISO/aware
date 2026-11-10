export const ROUTES = {
  DASHBOARD: '/',
  AGENTS: '/agents',
  CONSTRAINTS: '/constraints',
  KILL_SWITCH: '/kill-switch',
  ANOMALIES: '/anomalies',
  COMPLIANCE: '/compliance',
  AUDIT: '/audit',
};

// 2026-11-10 (scribe): the API base was hard-coded to
// 'http://localhost:8080/api'. Port 8080 on this host is occupied by an
// unrelated process (`reacher_b`), not by AWARE, and the v1 AWARE backend
// that the UI was written against is not running. Every compliance request
// therefore failed, and the container silently substituted mock numbers
// (see ComplianceContainer.js).
//
// The live AWARE surface is the v2 gateway (default port 18080), which
// serves /api/audit and now also /api/compliance. The default is
// same-origin relative, so the UI works behind nginx without any
// cross-origin configuration; operators override with
// REACT_APP_API_URL when the API is on a different origin.
export const API_BASE = process.env.REACT_APP_API_URL || '/api';
export const WS_URL = process.env.REACT_APP_WS_URL || 'ws://localhost:18080/ws';
export const DEBUG = process.env.REACT_APP_DEBUG === 'true';
export const APP_TITLE = process.env.REACT_APP_TITLE || 'AWARE Control Plane';
