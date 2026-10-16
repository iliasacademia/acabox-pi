const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const { sentryWebpackPlugin } = require('@sentry/webpack-plugin');

module.exports = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new webpack.DefinePlugin({
    'process.env.DATADOG_CLIENT_TOKEN': JSON.stringify(process.env.DATADOG_CLIENT_TOKEN || ''),
    'process.env.DATADOG_SITE': JSON.stringify(process.env.DATADOG_SITE || 'datadoghq.com'),
    'process.env.DATADOG_APPLICATION_ID': JSON.stringify(process.env.DATADOG_APPLICATION_ID || ''),
    'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || ''),
    'process.env.ONBOARDING_V2_ENABLED': JSON.stringify(process.env.ONBOARDING_V2_ENABLED || 'false'),
    'process.env.FULLSTORY_FORCE_RECORDING': JSON.stringify(process.env.FULLSTORY_FORCE_RECORDING || 'false'),
    'process.env.ENTRY_POINT': JSON.stringify(process.env.ENTRY_POINT || ''),
    'process.env.BROWSER_EXTENSION_VERSION': JSON.stringify(require('./package.json').browserExtensionVersion || ''),
    'process.env.APP_VERSION': JSON.stringify(require('./package.json').version || ''),
  }),
  new CopyWebpackPlugin({
    patterns: [
      {
        from: 'src/assets/icons',
        to: 'assets/icons',
      },
    ],
  }),
  // Sentry source-map upload. Runs once per webpack compilation (main + renderer);
  // each invocation uploads the maps from its own output directory, tagged with
  // the same `release` value the runtime Sentry SDK uses (package.json version).
  //
  // No-op when SENTRY_AUTH_TOKEN is unset (local dev, CI without the secret
  // configured) so the plugin doesn't fail the build.
  sentryWebpackPlugin({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: require('./product.json').name + '@' + require('./package.json').version },
    disable:
      !process.env.SENTRY_AUTH_TOKEN ||
      !process.env.SENTRY_ORG ||
      !process.env.SENTRY_PROJECT,
    telemetry: false,
    // Silent unless we're actually uploading (otherwise dev runs print noise).
    silent: !process.env.SENTRY_AUTH_TOKEN,
  }),
];
