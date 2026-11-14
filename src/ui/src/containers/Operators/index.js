/**
 * Operators screen (index) — the OHI operator-trust dashboard.
 *
 * Composes the list, the detail view and the pager, and owns the data
 * fetch. The three presentational pieces live beside this file:
 *
 *   OperatorList.js      the operators table
 *   OperatorDetail.js    one operator's gauge + history
 *   OperatorSparkline.js the score-over-time trace
 *
 * DATA SOURCE. The v1 diary table, via GET /api/diary/entries. The v1
 * schema has no operator column -- the producer stringifies its payload
 * into `content` -- so src/ui/src/constants/operators.js parses the
 * operator identity and score back out of that JSON.
 *
 * PAGINATION. The v1 endpoint is LIMIT-only (DiaryStore.list_entries takes
 * no offset), so the pager slices client-side over the fetched rows.
 * Server-side paging arrives with the v1 schema migration (card 3b).
 *
 * ERROR HANDLING. DESIGN.md §9 rule 8: 4xx/5xx are surfaced with a retry
 * affordance, not swallowed into fake data. Unlike the older containers
 * (ComplianceContainer falls back to mock numbers on error -- which is how
 * a broken endpoint became an invented dashboard), this screen shows the
 * error and the retry button and nothing else.
 *
 * ROUTING. The operator detail is a query-string selection
 * (?operator=<id>) rather than a nested route, so the screen keeps one
 * route in App.js and a selected operator survives a reload.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Pagination, Typography } from '@mui/material';
import { useSearchParams } from 'react-router-dom';

import OperatorList from './OperatorList';
import OperatorDetail from './OperatorDetail';
import { diaryAPI } from '../../services/api';
import {
  DIARY_MAX_LIMIT,
  OPERATOR_PAGE_SIZE,
  collectOperators,
  findOperator,
  paginate,
} from '../../constants/operators';

const Operators = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);

  const selectedOperatorId = searchParams.get('operator');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await diaryAPI.listEntries({ limit: DIARY_MAX_LIMIT });
      const rows = Array.isArray(res?.data?.entries) ? res.data.entries : [];
      setEntries(rows);
    } catch (err) {
      setError(err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const records = useMemo(() => collectOperators(entries), [entries]);
  const pageView = useMemo(
    () => paginate(records, page, OPERATOR_PAGE_SIZE),
    [records, page],
  );

  const selected = useMemo(
    () => findOperator(records, selectedOperatorId),
    [records, selectedOperatorId],
  );

  const handleSelect = useCallback(
    (operatorId) => {
      const next = new URLSearchParams(searchParams);
      next.set('operator', operatorId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h5" fontWeight={600}>
          Operators
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {records.length} operator{records.length === 1 ? '' : 's'} with recorded scores
        </Typography>
      </Box>

      {error ? (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          Could not load operator scores from the diary table.
        </Alert>
      ) : null}

      <OperatorList
        records={pageView.rows}
        selectedOperatorId={selectedOperatorId}
        onSelect={handleSelect}
      />

      {pageView.totalPages > 1 ? (
        <Box display="flex" justifyContent="flex-end" mt={2}>
          <Pagination
            count={pageView.totalPages}
            page={pageView.page + 1}
            onChange={(event, value) => setPage(value - 1)}
            color="primary"
          />
        </Box>
      ) : null}

      {selectedOperatorId ? (
        <Box mt={4}>
          <OperatorDetail record={selected} />
        </Box>
      ) : null}
    </Box>
  );
};

export default Operators;
