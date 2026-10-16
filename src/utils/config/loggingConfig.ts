import { app } from 'electron';
import { getDeviceId } from '../deviceId';
import { PRODUCT_NAME } from '../../cobuilding/shared/product';

// Helper function to detect channel from version string
export function getChannelFromVersion(): 'stable' | 'beta' {
  const version = app.getVersion();
  return version.includes('-beta') ? 'beta' : 'stable';
}

/**
 * Centralized logging configuration for the application.
 *
 * This config controls:
 * - DevTools logging (IPC to renderer)
 * - Terminal logging (console output)
 * - Datadog cloud logging
 * - Default metadata attached to all logs
 */
// Temporary flag to enable debug logs to Datadog for troubleshooting
// Set to true to enable, false to disable
export const DATADOG_DEBUG_LOGS_ENABLED = true;

export const LOGGING_CONFIG = {
  // Development logging toggles
  devToolsLogging: true, // Send logs to renderer DevTools console
  terminalLogging: false, // Output logs to terminal

  // Datadog configuration (using Client Token - safe for packaged apps)
  datadog: {
    // Enabled in production, or when feature flag is set in development
    enabled: process.env.DATADOG_ENABLED === 'true' || app.isPackaged,
    clientToken: process.env.DATADOG_CLIENT_TOKEN || '',
    site: process.env.DATADOG_SITE || 'datadoghq.com',
    service: PRODUCT_NAME,
    env: app.isPackaged ? 'production' : 'development',
    // RUM application id — required for Datadog RUM browser SDK. Public, safe to bundle.
    rumApplicationId: process.env.DATADOG_APPLICATION_ID || '',
  },

  // Sentry configuration (DSN is public, safe to bundle)
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    enabled: (process.env.SENTRY_DSN || '').length > 0,
    env: app.isPackaged ? 'production' : 'development',
  },

  // electron-log file configuration
  file: {
    maxSize: 5 * 1024 * 1024, // 5MB max file size
    devFileName: 'main-dev.log',
    getProductionFileName: () => `main-${getChannelFromVersion()}.log`,
  },

  // Default metadata attached to all logs
  getDefaultMetadata: () => ({
    appVersion: app.getVersion(),
    channel: getChannelFromVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    deviceId: getDeviceId(),
  }),
};

export type LoggingConfig = typeof LOGGING_CONFIG;
