// Builds the release APK the Maestro flows run against — without installing it.
//
//   node scripts/build-android-e2e.mjs
//
// `expo run:android --variant release` builds *and* installs, which needs a
// device attached. CI has no device at build time: the emulator only exists
// inside the emulator action's `script:` block, well after the APK is built. So
// this splits the build off and leaves installing to the caller.
//
// It also owns E2E_BUILD_ENV, which `test-mobile.mjs` imports. Those three vars
// are the difference between testing the app and testing a different app, so
// there is exactly one definition of them and both paths use it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = platform() === 'win32';
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const E2E_BUILD_ENV = {
  // Sentry's Gradle plugin uploads source maps on release builds and fails the
  // build without an auth token. A test build has no reason to.
  SENTRY_DISABLE_AUTO_UPLOAD: 'true',
  // Sync off, matching the web E2E config: no backend, no Firebase, no sign-in,
  // and no chance of a test run creating junk users in production.
  EXPO_PUBLIC_API_URL: '',
  EXPO_PUBLIC_SENTRY_DSN: '',
};

export const APK_PATH = join(appRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...E2E_BUILD_ENV },
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${command} ${args.join(' ')} failed\n`);
    process.exit(1);
  }
}

// Only run the build when invoked directly — importing this for E2E_BUILD_ENV
// must not kick off a twenty-minute Gradle run.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // `--clean` regenerates android/ from app.config.js rather than patching
  // whatever was there. The directory is gitignored, so on CI it is absent
  // anyway; locally this keeps a stale prebuild from silently changing what
  // gets tested.
  console.log('• prebuilding android/');
  run('npx', ['expo', 'prebuild', '-p', 'android', '--clean'], appRoot);

  console.log('• assembling release APK (several minutes)');
  run(isWindows ? 'gradlew.bat' : './gradlew', ['assembleRelease'], join(appRoot, 'android'));

  if (!existsSync(APK_PATH)) {
    console.error(`\n✗ build reported success but no APK at ${APK_PATH}\n`);
    process.exit(1);
  }

  console.log(`\n✓ ${APK_PATH}`);
}
