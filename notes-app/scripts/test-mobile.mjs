// One command for the mobile E2E run: emulator up, (optionally) rebuild, run the
// flows, tidy up. Exits with the flows' status so it can gate anything.
//
//   npm run test:mobile            # flows only — assumes the installed build is current
//   npm run test:mobile -- --build # rebuild + install first (needed after any code change)
//   npm run test:mobile -- --keep  # leave the emulator running afterwards
//
// The release APK has the JS bundled in, so nothing you edit reaches the device
// until you rebuild. `--build` is not optional after a code change; it's the
// whole difference between testing your work and testing yesterday's.
//
// An emulator that was already running is reused and left alone. One started
// here is shut down at the end unless --keep, so a failed run doesn't leave a
// couple of GB of emulator resident on the machine.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { E2E_BUILD_ENV } from './build-android-e2e.mjs';

const args = process.argv.slice(2);
const shouldBuild = args.includes('--build');
const keepEmulator = args.includes('--keep');

const AVD = process.env.MAESTRO_AVD ?? 'Medium_Phone_API_35';
const isWindows = platform() === 'win32';

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) fail('ANDROID_HOME is not set — install the Android SDK or point it at your install.');

const emulatorBin = join(sdk, 'emulator', isWindows ? 'emulator.exe' : 'emulator');
const adbBin = join(sdk, 'platform-tools', isWindows ? 'adb.exe' : 'adb');

// Maestro's documented `curl | bash` installer is Unix-only; on Windows the
// release zip is unpacked by hand, so look there before falling back to PATH.
const maestroBin = (() => {
  const local = join(homedir(), '.maestro-cli', 'maestro', 'bin', isWindows ? 'maestro.bat' : 'maestro');
  if (existsSync(local)) return local;
  const onPath = join(homedir(), '.maestro', 'bin', 'maestro');
  if (existsSync(onPath)) return onPath;
  return 'maestro';
})();

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// stderr is discarded: while the emulator boots, adb writes "no devices found"
// and "device offline" on every poll, which reads like a stream of failures when
// it is just the normal wait.
const adb = (...a) =>
  execFileSync(adbBin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function deviceOnline() {
  try {
    return adb('devices')
      .split('\n')
      .slice(1)
      .some((line) => line.trim().endsWith('\tdevice'));
  } catch {
    return false;
  }
}

async function waitForBoot(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (adb('shell', 'getprop', 'sys.boot_completed') === '1') return;
    } catch {
      // adb not ready yet; keep waiting.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  fail(`emulator did not finish booting within ${timeoutMs / 1000}s`);
}

let startedEmulator = null;

if (deviceOnline()) {
  console.log('• emulator already running — reusing it');
} else {
  console.log(`• starting emulator ${AVD} (headless)`);
  startedEmulator = spawn(emulatorBin, ['-avd', AVD, '-no-window', '-no-snapshot-load', '-no-boot-anim'], {
    detached: true,
    stdio: 'ignore',
  });
  startedEmulator.unref();
  await waitForBoot();
  console.log('• emulator booted');
}

if (shouldBuild) {
  console.log('• building + installing release APK (several minutes)');
  const build = spawnSync('npx', ['expo', 'run:android', '--variant', 'release'], {
    stdio: 'inherit',
    shell: true,
    // Shared with the CI build (scripts/build-android-e2e.mjs) so both produce
    // the same app. A local run that differed here would be testing something
    // CI never sees, and vice versa.
    env: { ...process.env, ...E2E_BUILD_ENV },
  });
  if (build.status !== 0) fail('build failed — see the Gradle output above');
}

// The notification shade can be left open by a previous run and covers the app,
// which shows up as a baffling "element not visible" failure.
try {
  adb('shell', 'cmd', 'statusbar', 'collapse');
} catch {
  // Best-effort only.
}

console.log('• running Maestro flows\n');
const flows = spawnSync(maestroBin, ['test', '.maestro/'], { stdio: 'inherit', shell: isWindows });

if (startedEmulator && !keepEmulator) {
  console.log('\n• shutting down the emulator we started');
  try {
    adb('emu', 'kill');
  } catch {
    // Already gone.
  }
}

process.exit(flows.status ?? 1);
