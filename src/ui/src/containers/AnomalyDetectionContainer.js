import React, { useEffect, useState } from 'react';
import { Box, Alert, CircularProgress } from '@mui/material';
import AnomalyDetectionAlerts from '../components/AnomalyDetectionAlerts';
import { anomalyAPI } from '../services/api';
import { SEVERITY_LEVELS } from '../constants/severity';

// Sample data for the OFFLINE state only — never a stand-in for a live payload.
//
// This fixture used to be the masking mechanism behind card t_775073b4. It
// carried 'warning' / 'critical', which are the COMPONENT'S OWN vocabulary
// rather than the API's, and it was rendered from the `catch` branch. The
// result was that the anomaly panel only ever rendered correctly when the
// request FAILED: the live path emitted high/medium/low and every severity
// fell through to the default colour with every counter at 0, while the
// fixture quietly proved the component could render. Nine days of audits and
// a `done` card missed a live defect because this fallback looked correct.
//
// Two changes, both load-bearing:
//   1. The severities come from the canonical enum, so this file can never
//      again be a second, independent severity vocabulary. Deriving them
//      means a future rename moves the fixture with the contract instead of
//      stranding it.
//   2. The fallback is announced. A panel showing plausible-looking alert
//      cards must not be mistaken for real data; if the API is down the
//      operator has to see that, not a set of well-formatted fiction.
//
// This is NOT a mock of the API's response shape — it is a visible error
// state. Anything else re-creates the exact failure this file used to cause.
const sampleSeverities = SEVERITY_LEVELS;

const sampleAnomalies = [
  {
    id: 'sample-1',
    title: 'Sample record — the monitoring API is unreachable',
    severity: sampleSeverities[0],
    description: 'This card is placeholder data shown because GET /api/anomalies failed. It is not a detected anomaly.',
    agentId: 'agent-unavailable',
    detectedAt: null,
    acknowledged: false,
  },
];

const AnomalyDetectionContainer = () => {
  const [anomalies, setAnomalies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await anomalyAPI.list();
        setAnomalies(res.data);
      } catch (err) {
        // Surface the failure instead of replacing it with data that renders
        // correctly. The old catch branch did exactly that, and the correct
        // rendering it produced is what hid the live defect for nine days.
        setError(err);
        setAnomalies(sampleAnomalies);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return <Box display="flex" justifyContent="center" p={4}><CircularProgress /></Box>;

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load anomalies from the monitoring API. The panel below is
          placeholder data, not detected anomalies.
        </Alert>
      )}
      <AnomalyDetectionAlerts anomalies={anomalies} />
    </Box>
  );
};

export default AnomalyDetectionContainer;