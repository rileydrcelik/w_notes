// Sentry wraps the default Expo Metro config so it can emit source maps for
// readable stack traces. Behaves exactly like `expo/metro-config` otherwise.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// --- Web SQLite support -----------------------------------------------------
// On web, expo-sqlite runs SQLite (wa-sqlite) inside a worker that loads a
// `.wasm` engine, so Metro must bundle `.wasm` as an asset.
config.resolver.assetExts.push('wasm');

// That worker talks to the main thread over a SharedArrayBuffer, which browsers
// only expose to cross-origin-isolated pages. Send the COOP/COEP headers on the
// web dev server so SharedArrayBuffer is available and the database initializes
// (and persists to OPFS). The static export's host must send the same headers.
//
// COEP is `credentialless`, not `require-corp`: both keep the page cross-origin
// isolated (so SharedArrayBuffer stays available), but `require-corp` forces
// every cross-origin subresource to carry a CORP header, which Firebase's auth
// iframe/resources don't — that would break the Google redirect sign-in.
// `credentialless` instead loads such cross-origin resources without credentials,
// which the auth round trip doesn't need. COOP stays `same-origin`: the web flow
// uses signInWithRedirect (see providers.web.ts), so there's no popup opener to
// preserve.
config.server = config.server || {};
const previousEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (metroMiddleware, metroServer) => {
  const base = previousEnhanceMiddleware
    ? previousEnhanceMiddleware(metroMiddleware, metroServer)
    : metroMiddleware;
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    return base(req, res, next);
  };
};

module.exports = config;
