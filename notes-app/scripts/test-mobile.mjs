// One command for the mobile E2E run: emulator up, (optionally) rebuild, run the
// flows, tidy up. Exits with the flows' status so it can gate anything.
//
//   npm run test:mobile            # flows only — assumes the installed build is current
//   npm run test:mobile -- --build # rebuild + install first (needed after any code change)
//   npm run test:mobile -- --keep  # leave the emulator running afterwards
//
// Exactly one device must be attached, or the run stops and says so. With more
// than one, name the one you mean:
//
//   MAESTRO_DEVICE=emulator-5554 npm run test:mobile
//
// The device is not a detail: the same flow passes on a phone and fails on a
// software-GPU emulator, so a result is only readable next to the device that
// produced it. Every run prints which one it used.
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

/** Serials of every attached device that is actually ready for commands. */
function onlineDevices() {
  try {
    return adb('devices')
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('\tdevice'))
      .map((line) => line.split('\t')[0]);
  } catch {
    return [];
  }
}

function deviceOnline() {
  return onlineDevices().length > 0;
}

/** `ro.product.model` for a serial, or the serial itself if the prop is unreadable. */
function deviceModel(serial) {
  try {
    return (
      execFileSync(adbBin, ['-s', serial, 'shell', 'getprop', 'ro.product.model'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || serial
    );
  } catch {
    return serial;
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
  // No `-gpu` flag on purpose: the default picks host acceleration where it is
  // available, and that is what makes this usable at all. Forcing
  // `-gpu swiftshader_indirect` here to match CI was tried and made it strictly
  // worse — software rendering starved the emulator badly enough that SystemUI
  // itself ANR'd on a black screen and even the assert-only `smoke` flow failed
  // before the app drew a frame. CI can afford swiftshader because its runner
  // has nothing else to do; a developer machine cannot.
  startedEmulator = spawn(emulatorBin, ['-avd', AVD, '-no-window', '-no-snapshot-load', '-no-boot-anim'], {
    detached: true,
    stdio: 'ignore',
  });
  startedEmulator.unref();
  await waitForBoot();
  console.log('• emulator booted');
}

// Which device everything below runs on, decided here rather than left to
// whatever adb happens to list first.
//
// This is not hypothetical tidiness. A run that silently retargeted a plugged-in
// phone to the emulator once cost an afternoon: the same flow passed on the
// phone and failed on the emulator, which read as "the last commit broke the
// create button" when it was only ever a slower device turning a tap into a long
// press. `deviceOnline()` counted any attached device as "an emulator is already
// running", and Maestro was given no `--device` at all — so the build could land
// on one device and the flows run on another. Pick one, use it everywhere, and
// say out loud which it was: the one log line that turns that hunt into a glance.
const attached = onlineDevices();
const target = process.env.MAESTRO_DEVICE ?? (attached.length === 1 ? attached[0] : null);

if (!target) {
  fail(
    `expected exactly one attached device, found ${attached.length}${attached.length ? `: ${attached.join(', ')}` : ''}\n` +
      '  Unplug the others, or name one: MAESTRO_DEVICE=<serial> npm run test:mobile\n' +
      '  Which device ran the flows decides whether a failure means anything.',
  );
}
if (!attached.includes(target)) {
  fail(`MAESTRO_DEVICE=${target} is not attached (online: ${attached.join(', ') || 'none'})`);
}

if (shouldBuild) {
  console.log('• building + installing release APK (several minutes)');
  // --no-bundler: the release APK carries its own JS, so Metro has nothing to
  // serve it — but without the flag `run:android` starts one anyway and stays
  // attached to it after installing, so this spawnSync never returned and the
  // flows never ran. It only ever looked fine because 8081 happened to be taken,
  // which makes the CLI skip the dev server and exit.
  // --device pins the install to the same device the flows use below. Without it
  // the APK can land on one attached device while Maestro drives another, so the
  // run silently tests the *previous* build.
  const build = spawnSync('npx', ['expo', 'run:android', '--variant', 'release', '--no-bundler', '--device', target], {
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
  adb('-s', target, 'shell', 'cmd', 'statusbar', 'collapse');
} catch {
  // Best-effort only.
}

console.log(`• running Maestro flows on ${target} (${deviceModel(target)})\n`);
const flows = spawnSync(maestroBin, ['test', '--device', target, '.maestro/'], {
  stdio: 'inherit',
  shell: isWindows,
});

if (startedEmulator && !keepEmulator) {
  console.log('\n• shutting down the emulator we started');
  try {
    adb('-s', target, 'emu', 'kill');
  } catch {
    // Already gone.
  }
}

process.exit(flows.status ?? 1);
