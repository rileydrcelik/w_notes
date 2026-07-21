# Git hooks

Versioned hooks, opted into per clone:

```sh
git config core.hooksPath .githooks
```

Git doesn't version `.git/hooks`, so this points it here instead. Run it once
after cloning; without it these are inert files.

## pre-push

Runs the mobile E2E flows before a push that touches native-relevant code, and
only then. Every other push is unaffected.

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

Bypass a single push:

```sh
git push --no-verify
```

If you reach for that routinely, the path list is too broad — narrow it rather
than keeping a hook you always skip. A gate everyone bypasses is worse than no
gate, because it looks like protection.
