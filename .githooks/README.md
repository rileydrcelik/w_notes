# Git hooks

Versioned hooks, opted into per clone:

```sh
git config core.hooksPath .githooks
```

Git doesn't version `.git/hooks`, so this points it here instead. Run it once
after cloning; without it these are inert files.

## pre-push

Two gates: the app version has to move when shipped code moves, and the mobile
E2E flows run before a push that touches native-relevant code.

### Gate 1 — the version

Only on pushes to `main`, and only when the diff touches something that ships:
`notes-app/src`, `notes-app/assets`, `notes-app/app.config.js`,
`notes-app/patches`, or `backend/`.

The three digits of `1.2.3` are not interchangeable, because `app.config.js`
derives the OTA runtime version from the first two:

| digit | when | runtime version | how it reaches devices |
|---|---|---|---|
| **major** | rare, and a human decides | new | new build |
| **minor** | a new binary is required | new | `eas build` — devices on the old lineage are cut off until they install it |
| **patch** | everything else: backend deploys, OTA pushes, small fixes | unchanged | `eas update` — lands on installs already in the field |

So the gate checks two things, not one. Any shipped change must move *some*
digit; a change compiled into the binary must move the **minor**. Held at the
same lineage, an `eas update` would land that JS on binaries lacking the native
code it calls: green on every test, a crash on the device.

What counts as compiled into the binary:

```
notes-app/android/**
notes-app/patches/**
notes-app/app.config.js
notes-app/app.json         — anything but its version line
notes-app/package.json     — anything but its version line
```

The last two can't be matched by filename, because they also move for the bump
itself. The hook diffs them and filters out the `"version":` line, so what
remains is a real change: a new plugin or permission, an added dependency.
That's whole-file rather than per-key on purpose — the two failure modes aren't
symmetric. A false positive costs one unnecessary minor bump; a false negative
ships an update onto devices that never got the native code.

Skip it for one push when you know it's unrelated:

```sh
ALLOW_STALE_VERSION=1 git push
```

### Gate 2 — mobile E2E

Runs before a push that touches native-relevant code, and only then. Every
other push is unaffected.

It exists because mobile is the one suite CI can't carry: a native build on a
GitHub runner exceeded 45 minutes, against ~1 minute locally against a warm
emulator. The trigger lives here rather than in Actions for that reason alone.

Paths that fire it — where a change can break the native app without touching
the web build:

```
notes-app/src/lib/db.ts
notes-app/src/**/*.native.ts(x)
notes-app/android/**
notes-app/package.json
notes-app/.maestro/**
```

It always rebuilds (`--build`), because the files that triggered it are the ones
compiled into the release APK — the installed build is stale by definition. So
expect several minutes when it fires, and nothing at all when it doesn't.

Bypass a single push — this one skips **both** gates:

```sh
git push --no-verify
```

If you reach for that routinely, the path list is too broad — narrow it rather
than keeping a hook you always skip. A gate everyone bypasses is worse than no
gate, because it looks like protection.
