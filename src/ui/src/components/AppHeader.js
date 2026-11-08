import React from 'react';
import { AppBar, Toolbar, Typography, Badge, IconButton, Box } from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import NotificationsIcon from '@mui/icons-material/Notifications';
import SettingsIcon from '@mui/icons-material/Settings';
import { useSelector } from 'react-redux';
import { APP_TITLE } from '../constants';

const AppHeader = () => {
  const { unreadKillEvents, criticalAnomalies } = useSelector((state) => state.alerts);
  const totalAlerts = unreadKillEvents + criticalAnomalies;

  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{ borderBottom: (theme) => `1px solid ${theme.palette.overlay.dividerStrong}` }}
    >
      <Toolbar>
        <SecurityIcon sx={{ mr: 2, color: 'primary.main' }} />
        <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>
          {APP_TITLE}
        </Typography>
        <Box display="flex" alignItems="center" gap={1}>
          <Badge badgeContent={totalAlerts > 0 ? totalAlerts : null} color="error">
            <IconButton color="inherit" size="large">
              <NotificationsIcon />
            </IconButton>
          </Badge>
          <IconButton color="inherit" size="large">
            <SettingsIcon />
          </IconButton>
        </Box>
      </Toolbar>
    </AppBar>
  );
};

export default AppHeader;
