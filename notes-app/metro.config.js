// Sentry wraps the default Expo Metro config so it can emit source maps for
// readable stack traces. Behaves exactly like `expo/metro-config` otherwise.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = config;
