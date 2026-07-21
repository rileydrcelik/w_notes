// Reclaims host disk from the E2E emulator by deleting its qcow2 overlays.
//
//   npm run emulator:clean
//
// Why this exists: uninstalling apps *inside* the emulator frees the guest
// partition but returns nothing to your disk. Android stores writes in qcow2
// overlay files that only ever grow — deleting a 200MB app inside the guest
// shrinks the overlay by zero bytes. The only way to reclaim host space is to
// delete the overlay, which necessarily resets the guest. The two are not
// separable, so this script does both and says so.
//
// The gap is wide enough to be misleading: a freshly wiped emulator reported
// 12% used inside the guest while its overlay was already 2.2GB on the host.
// Checking `df` on the device will not warn you in time.
//
// Cost of running this: the next boot rebuilds ~2GB of overlay and the E2E
// suite reinstalls the app (the pre-push hook always passes --build anyway),
// so nothing is lost beyond a slower first run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const AVD = process.env.MAESTRO_AVD ?? 'Medium_Phone_API_35';
const isWindows = platform() === 'win32';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

/**
 * Resolve the AVD's data directory.
 *
 * Not `<name>.avd` — the directory name and the AVD name routinely differ
 * (a device created as "Medium_Phone" then renamed to "Medium_Phone_API_35"
 * keeps the old folder). The `<name>.ini` beside it is the authoritative
 * mapping, so read `path=` from there and only fall back to the guess.
 */
function avdDir() {
  const root = process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd');
  const ini = join(root, `${AVD}.ini`);

  if (existsSync(ini)) {
    const line = readFileSync(ini, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('path='));
    if (line) {
      const dir = line.slice('path='.length).trim();
      if (existsSync(dir)) return dir;
    }
  }

  const guess = join(root, `${AVD}.avd`);
  if (existsSync(guess)) return guess;
  fail(`could not locate the AVD directory for '${AVD}' (looked in ${root})`);
}

/** Shut the emulator down if it's running — deleting overlays under a live VM corrupts it. */
function ensureStopped() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) return; // No SDK on PATH: assume it isn't running rather than block the clean.
  const adb = join(sdk, 'platform-tools', isWindows ? 'adb.exe' : 'adb');
  if (!existsSync(adb)) return;

  const devices = () => {
    try {
      return execFileSync(adb, ['devices'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.includes('emulator-') && l.includes('device'));
    } catch {
      return [];
    }
  };

  if (devices().length === 0) return;

  console.log('• emulator is running — shutting it down first');
  try {
    execFileSync(adb, ['emu', 'kill'], { stdio: 'ignore' });
  } catch {
    // Already gone, or refused the command; the wait below decides.
  }

  // Deleting the overlays while qemu still holds them leaves a broken AVD, so
  // this is a hard gate rather than a courtesy sleep.
  for (let i = 0; i < 30; i++) {
    if (devices().length === 0) return;
    execFileSync(isWindows ? 'cmd' : 'sleep', isWindows ? ['/c', 'timeout /t 1 /nobreak'] : ['1'], {
      stdio: 'ignore',
    });
  }
  fail('emulator did not shut down — close it manually, then re-run');
}

const dir = avdDir();
ensureStopped();

const overlays = readdirSync(dir).filter((f) => f.endsWith('.qcow2'));
if (overlays.length === 0) {
  console.log(`✓ nothing to reclaim — ${AVD} has no overlays (already clean)`);
  process.exit(0);
}

let freed = 0;
for (const file of overlays) {
  const full = join(dir, file);
  const size = statSync(full).size;
  rmSync(full);
  freed += size;
  console.log(`  removed ${file} (${mb(size)})`);
}

console.log('');
console.log(`✓ reclaimed ${mb(freed)} from ${AVD}`);
console.log('  the guest was reset; the next E2E run rebuilds and reinstalls automatically.');
