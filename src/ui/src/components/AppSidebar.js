import React from 'react';
import { Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Box, Divider, Typography } from '@mui/material';
import { Link, useLocation } from 'react-router-dom';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import ShieldIcon from '@mui/icons-material/Security';
import PowerOffIcon from '@mui/icons-material/PowerSettingsNew';
import WarningIcon from '@mui/icons-material/Warning';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import HistoryIcon from '@mui/icons-material/History';

const DRAWER_WIDTH = 260;

const menuItems = [
  { text: 'Dashboard', icon: <DashboardIcon />, path: '/' },
  { text: 'Agent Identity', icon: <PersonOutlineIcon />, path: '/agents' },
  { text: 'Constraint Enforcement', icon: <ShieldIcon />, path: '/constraints' },
  { text: 'Kill Switch', icon: <PowerOffIcon />, path: '/kill-switch' },
  { text: 'Anomaly Detection', icon: <WarningIcon />, path: '/anomalies' },
  { text: 'Compliance Mapping', icon: <VerifiedUserIcon />, path: '/compliance' },
  { text: 'Audit Trail', icon: <HistoryIcon />, path: '/audit' },
];

const AppSidebar = () => {
  const location = useLocation();

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          backgroundColor: 'background.paper',
          borderRight: (theme) => `1px solid ${theme.palette.overlay.divider}`,
        },
      }}
    >
      <Box sx={{ p: 2, borderBottom: (theme) => `1px solid ${theme.palette.overlay.divider}` }}>
        <Typography variant="subtitle2" color="primary.main" fontWeight={700} letterSpacing={1.5}>
          AWARE
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Security Control Plane
        </Typography>
      </Box>
      <List sx={{ pt: 1 }}>
        {menuItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <ListItem key={item.text} disablePadding>
              <ListItemButton
                component={Link}
                to={item.path}
                sx={{
                  // overlay.active is primary.main at 10%, derived by alpha().
                  // The literal form looked token-correct (it WAS the right
                  // colour) but could not follow primary.main if it moved.
                  backgroundColor: (theme) =>
                    isActive ? theme.palette.overlay.active : 'transparent',
                  borderRight: isActive ? '3px solid primary.main' : '3px solid transparent',
                  '&:hover': { backgroundColor: (theme) => theme.palette.overlay.hover },
                }}
              >
                <ListItemIcon sx={{ color: isActive ? 'primary.main' : 'text.secondary' }}>
                  {item.icon}
                </ListItemIcon>
                {/* The nav label wants a 14px body, not ListItemText's
                    default body1 (1rem). Select the scale step via the
                    framework's own variant rather than overriding fontSize
                    with a hardcoded 0.875rem, so a theme typography change
                    moves this label with the rest of the scale.

                    NOT a zero-visual-change: body2 is 14px (same as the old
                    literal) but its line-height is 1.43, where body1's is
                    1.5. The label's leading tightens from 21px to 20.02px.
                    See test/unit/ui/sidebar-typography.test.js, which pins
                    the resolved values against the REAL theme. */}
                <ListItemText primary={item.text} primaryTypographyProps={{ variant: 'body2' }} />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
      <Divider sx={{ mx: 2 }} />
      <Box sx={{ p: 2, mt: 'auto' }}>
        <Typography variant="caption" color="text.secondary">
          v1.0.0 — Control Plane
        </Typography>
      </Box>
    </Drawer>
  );
};

export default AppSidebar;
