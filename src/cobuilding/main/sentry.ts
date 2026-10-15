/**
 * Cobuilding main-process Sentry init.
 *
 * Imported only from main-process code paths so the renderer bundle never
 * pulls in `@sentry/electron/main` (which depends on Node-only modules and
 * cannot be bundled for the renderer).
 */

import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { setCaptureImpl } from '../shared/telemetry';
import { PRODUCT_NAME } from '../shared/product';

/**
 * Initialize Sentry in the main process.
 *
 * Must be called after `app.setPath('userData', ...)` so native minidumps land
 * in the right directory. Native crash reporting is set up automatically by
 * @sentry/electron — no separate `crashReporter.start()` is required.
 *
 * The user-identity on Sentry's scope is `installationId` (the per-device
 * UUID from `getDeviceId()`). Without this, Sentry shows "Users: 0" on every
 * issue because it has no identity to count against. @sentry/electron
 * propagates scope from main to renderer via IPC, so setting once here
 * covers both processes.
 *
 * No-op if `SENTRY_DSN` is empty.
 */
export function initSentryMain(installationId: string): void {
  if (!process.env.SENTRY_DSN) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Prefix the release with the app slug so events stay filterable even if a
    // build ever reuses the original app's Sentry DSN. Must match the release
    // name the source-map upload uses in webpack.plugins.js.
    release: `${PRODUCT_NAME}@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    tracesSampleRate: 0.1,
    // Session tracking for release-health is enabled by default in @sentry/electron v7+.
    // Manual uncaughtException / unhandledRejection handlers live in
    // src/cobuilding/main/index.ts so they can also write to electron-log.
    // Drop Sentry's default integrations to avoid double-capture.
    integrations: (defaults) =>
      defaults.filter(
        (i) =>
          i.name !== 'OnUncaughtException' &&
          i.name !== 'OnUnhandledRejection'
      ),
  });

  Sentry.setTag('app', PRODUCT_NAME);
  Sentry.setUser({ id: installationId });

  setCaptureImpl((error, options) => {
    Sentry.captureException(error, {
      tags: options?.subsystem ? { subsystem: options.subsystem } : undefined,
      extra: options?.extra,
    });
  });
}
