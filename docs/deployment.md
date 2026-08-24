# Deployment

Three things ship independently: the **backend**, the **web app**, and the
**mobile app**. One version number covers them all.

## Versioning

`notes-app/app.json` → `expo.version` is authoritative. It must match
`package.json` and both `version` fields in `package-lock.json`; the pre-push
hook fails the push if they drift.

The OTA **runtime version** is derived from it in `app.config.js` by dropping the
patch digit. That makes the digit you bump a decision about *how the release
reaches people*:

| Bump | Display | Runtime | Ships as |
|---|---|---|---|
| patch | `1.2.3` → `1.2.4` | `1.2`, unchanged | `eas update` — lands on binaries already installed |
| minor | `1.2.4` → `1.3.0` | `1.2` → `1.3` | `eas build` — devices on `1.2` stop getting updates until they install it |
| major | `1.3.0` → `2.0.0` | new | a new build, plus whatever makes it a major |

**Patch is the default** — JS changes, backend deploys, fixes, even large
features. **Minor is required** whenever the release contains something a device
cannot receive as JavaScript: anything under `notes-app/android/` or
`notes-app/patches/`, *any* dependency change, or a change to `app.config.js` or
`app.json` beyond its version line.

> A minor bump cuts every existing install off from OTA updates until it
> installs a new binary. That is correct when native code changed — those devices
> lack the code the new JS calls — and needlessly disruptive when it did not.

Android `versionCode` and iOS `buildNumber` are owned by EAS
(`appVersionSource: "remote"`, `autoIncrement`). Do not set them locally.

## Backend

Push to `main` touching `backend/**` and `.github/workflows/deploy-backend.yml`
builds the image, pushes it to ECR, and rolls the ECS service
(`.github/workflows/deploy-backend.yml`, authenticating via OIDC). It can also
be run by hand from the Actions tab — which is what you do after a
`terraform apply`.

The image is tagged with the commit SHA and gets its own task definition
revision, so ECS has a real previous revision to roll back to when the circuit
breaker trips.

> Docs under `backend/docs/**` are excluded from the trigger on purpose. At
> `desired_count = 1`, rolling the service is a brief gap in service — not worth
> spending on a README edit.

## Infrastructure

Terraform lives in `terraform/` and is **always applied by hand**. CI never runs
it.

```sh
cd terraform && terraform plan && terraform apply
```

> Most infra changes need two steps: `terraform apply` creates the parameter or
> permission, and a **backend redeploy** gives the running task a definition that
> reads it. Doing only the first looks like nothing happened. Doing only the
> second can take the service down — a task that references a parameter which
> does not exist yet will not start.

## Shipping a version bump

The version gate makes `expo.version` move whenever shipped code changes. It
does **not** ship it: web and mobile are both hand-run, so the repo can say
1.1.2 while both surfaces still serve 1.1.0. That happened — for a day, and it
was noticed by opening Settings on a phone and reading the number.

A version in git is a claim that something shipped. Check the claim:

```sh
cd notes-app
npm run version:status
```

```
repo (app.json)  1.1.2
web (live)       1.1.0
mobile (OTA)     runtime 1.1 — "1.1.0 - ..."
```

Then ship whichever is behind:

```sh
npm run ship:web      # build:web (export → fix → verify) → wrangler deploy
npm run ship:mobile   # verify:update → eas update --channel production
```

> A **patch** bump ships via `eas update` and needs no build — the runtime
> lineage (`major.minor`) is unchanged, so it reaches binaries already in the
> field. A **minor** bump is the deliberate "this needs a real build", and an
> `eas update` alone will not reach anyone until that build is installed.

> `ship:mobile` runs `verify:update` first, and that gate matters as much as the
> web one. A stale `.env.local` baked `http://localhost:8000` into the web
> bundle once; the same file poisons an OTA the same way, except a bad update
> has already reached every phone on the channel and the fix is another update
> those phones have to be working well enough to fetch.

## Web

Cloudflare Pages, deployed with wrangler by hand:

```sh
cd notes-app
npm run build:web     # export → fix-web-export → verify
npx wrangler pages deploy dist
```

> Run the deploy from `notes-app/`, not from `dist/` or the repo root. Wrangler
> compiles `./functions` relative to the deploy directory, and
> `functions/__/[[path]].js` is what proxies Firebase Auth's `/__/*` endpoints
> same-origin. Deploy from the wrong directory and sign-in hangs on web: the page
> is cross-origin isolated for `wa-sqlite`'s `SharedArrayBuffer`, so a
> cross-origin auth iframe never returns its result.

`build:web` is three steps and all three matter:

1. `expo export -p web --clear`.
2. `scripts/fix-web-export.mjs` — Cloudflare **drops any directory named
   `node_modules`**, which takes `wa-sqlite.wasm` and the icon fonts with it. The
   script renames the directory and rewrites every reference.
3. `scripts/verify-web-export.mjs` — gates the export. Every check here is an
   outage this project has actually had.

> The one that bites hardest: a stale `.env.local` once baked
> `http://localhost:8000` into the production bundle as the API URL. Web talked
> to a stopped local backend and silently stopped syncing, with nothing visibly
> broken. The verify script counts `localhost:8000` in `dist` and it must be
> zero. If web sync ever breaks, check the browser console first.

None of this is reachable from a unit, integration, or browser test — a bundle
is a build artifact, so the export is the only place it can be checked.

## Mobile

Builds go through EAS. Three variants, each with its own Android package name so
they install side by side (`app.config.js`, `eas.json`):

| Variant | Package | Channel |
|---|---|---|
| development | `com.rileydrcelik.wnotes.dev` | `development` |
| preview | `com.rileydrcelik.wnotes.preview` | `preview` |
| production | `com.rileydrcelik.wnotes.app` | `production` |

```sh
eas build --profile production --platform android
eas update --channel production      # JS-only, patch releases
```

> Each Android package needs **its own Google Cloud OAuth client** (package name
> plus SHA-1). Without one, Google Sign-In throws `DEVELOPER_ERROR` on that
> variant only.

An `eas update` only reaches devices whose installed binary carries a matching
runtime version — see [Versioning](#versioning).

## The pre-push hook

`.githooks/pre-push`, opted into with `git config core.hooksPath .githooks`. Two
gates:

1. **The version moved.** On pushes to `main`, when the diff touches something
   that ships (`notes-app/src`, `notes-app/assets`, `app.config.js`,
   `notes-app/patches`, `backend/`), some digit must move — and a change compiled
   into the binary must move the minor.
2. **Mobile E2E ran.** A native-relevant change builds and installs a release APK
   and runs the flows against it.

> An `unauthorized` phone on USB blocks gate 2 even with an emulator running, and
> `ANDROID_SERIAL` does not override it. Unplug it or authorize it.

## Where it runs

| | |
|---|---|
| API | `https://api.w-notes.app` — ECS Fargate Spot behind a Cloudflare Tunnel |
| Database | RDS Postgres, private, no public address |
| Files | S3, reached by presigned URL |
| Secrets | SSM Parameter Store |
| Web | Cloudflare Pages |
| Region | `us-east-1`, roughly $26/month |

To inspect production Postgres, open a CloudShell **in the VPC** (public subnet,
`wnotes-ecs` security group) and connect with `psql sslmode=require`. The
password is in SSM at `/wnotes/database-url` — read it in a normal tab, since
CloudShell in-VPC has no internet route to the SSM console.
