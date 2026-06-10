# w_notes

A glassmorphic notes app built with Expo (React Native). Notes, folders, and
the copy/paste feed are stored **on-device with SQLite** — no server, works
offline.

```
notes-app/
  src/lib/db.ts        on-device SQLite storage (the data layer)
  src/store/           React stores (hydrate from SQLite, write through to it)
  src/app/             screens (expo-router)
```

## Running the app

```bash
cd notes-app
npm install            # first time only
```

SQLite is a native module, so it must be included in a **dev build** — it won't
work in the prebuilt Expo Go app. Build and run the dev client once:

```bash
npx expo run:android   # or: npx expo run:ios
```

After that, day to day you can just start the bundler:

```bash
npx expo start         # press a / i to open on the dev build
```

> Re-run `npx expo run:android` again only when native deps change.

## Where the data lives

The database is a file (`wnotes.db`) inside the app's own sandbox on the
device/emulator. It persists across app restarts. Tables are created
automatically on first launch (see `src/lib/db.ts`).

To inspect it during development, use Expo's SQLite dev tools, or reset it by
clearing the app's data / reinstalling.
