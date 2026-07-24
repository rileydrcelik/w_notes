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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// Two edits to Expo's generated gradle.properties, both after prebuild because
// prebuild regenerates the file — which is also why neither can live in a
// checked-in properties file or a CI `with:` block.
//
// 1. Memory. The generated file ships -XX:MaxMetaspaceSize=512m, which KSP
//    exhausts on this module set — :expo-updates:kspReleaseKotlin dies with
//    "OutOfMemoryError: Metaspace". Worse, Gradle doesn't abort cleanly when it
//    happens: the daemon wedges and sits there until something kills the job, so
//    the symptom looks like a slow build rather than a failed one. Values are
//    sized for a GitHub-hosted runner (4 vCPU / 16 GB).
//
// 2. The build cache. Expo doesn't enable it, and without it the CI Gradle cache
//    is decorative: setup-gradle restores ~/.gradle faithfully, but with caching
//    off no task ever reads from it. The measured result was `1028 actionable
//    tasks: 1028 executed` and a 27-minute build on a fully warm cache — every
//    run, forever. This one line is what makes the caching the workflow already
//    does actually pay out.
function tuneGradleProperties() {
  const propsPath = join(appRoot, 'android', 'gradle.properties');
  const original = readFileSync(propsPath, 'utf8');

  let patched = original.replace(
    /^org\.gradle\.jvmargs=.*$/m,
    'org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m',
  );
  if (patched === original) {
    console.warn('! could not find org.gradle.jvmargs to patch — build may OOM in KSP');
  } else {
    console.log('• raised Gradle heap/metaspace for the release build');
  }

  // Appended rather than replaced: prebuild's output has no caching line at all,
  // so there is nothing to substitute. Guarded so a future Expo template that
  // does set it doesn't end up with two conflicting entries.
  if (!/^org\.gradle\.caching=/m.test(patched)) {
    patched += '\norg.gradle.caching=true\n';
    console.log('• enabled the Gradle build cache');
  }

  writeFileSync(propsPath, patched);
}

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
  // Deliberately *not* `--clean`. Regenerating android/ from scratch forces a
  // cold build every time, which on CI cost ~25 minutes and a step timeout.
  // The directory is gitignored so CI starts without it regardless, and
  // prebuild is deterministic from app.config.js — the clean bought nothing
  // there while guaranteeing the slowest possible path.
  console.log('• prebuilding android/');
  run('npx', ['expo', 'prebuild', '-p', 'android'], appRoot);

  tuneGradleProperties();

  console.log('• assembling release APK (several minutes)');
  // Android lint has nothing to say about a build whose only purpose is to be
  // driven by Maestro, and lintVitalAnalyze is one of the more expensive tasks
  // in the graph. `assembleRelease` pulls it in automatically, so it has to be
  // excluded explicitly.
  run(
    isWindows ? 'gradlew.bat' : './gradlew',
    ['assembleRelease', '-x', 'lintVitalRelease', '-x', 'lintVitalAnalyzeRelease'],
    join(appRoot, 'android'),
  );

  if (!existsSync(APK_PATH)) {
    console.error(`\n✗ build reported success but no APK at ${APK_PATH}\n`);
    process.exit(1);
  }

  console.log(`\n✓ ${APK_PATH}`);
}
