import React, { useEffect, useState } from 'react';
import { Box, Alert, CircularProgress } from '@mui/material';
import ComplianceMapping from '../components/ComplianceMapping';
import { complianceAPI } from '../services/api';

// 2026-11-10 (scribe): the mockCoverage / mockEvidence / mockReadiness
// fixtures were deleted. They were not placeholders for "not yet wired" —
// they were being rendered as if they were measurements:
//
//   iso27001: 89, soc2: 72, gdpr: 65, aiact: 34, overall: 65
//
// A failed fetch fell through to the catch block, which set these values,
// and the UI displayed them as live compliance scores. The real engine's
// measured posture is 0% with 0 controls assessed and 0 evidence collected.
// Showing 65% when the truth is "nothing has been assessed" is a
// misstatement to anyone reading the dashboard, and to any auditor who
// screenshots it.
//
// A fetch failure now surfaces as an error state. There is no code path
// that produces a compliance number without a live API response behind it.

const ComplianceContainer = () => {
  const [posture, setPosture] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [frameworks, setFrameworks] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [postureRes, evidenceRes, frameworksRes] = await Promise.all([
          complianceAPI.getPosture(),
          complianceAPI.getEvidence(),
          complianceAPI.getFrameworks(),
        ]);
        if (cancelled) return;
        setPosture(postureRes.data);
        setEvidence(evidenceRes.data);
        setFrameworks(frameworksRes.data?.frameworks || []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Failed to load compliance data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <Box display="flex" justifyContent="center" p={4}><CircularProgress /></Box>;
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        Compliance data could not be loaded: {error}. No compliance figures are
        shown because none could be retrieved — the dashboard does not fall
        back to placeholder values.
      </Alert>
    );
  }

  return (
    <ComplianceMapping
      posture={posture}
      evidence={evidence}
      frameworks={frameworks}
    />
  );
};

export default ComplianceContainer;
