# Handoff — note images, issue grids, code blocks (2026-09-18)

**Status at pause: six commits on `main`, none pushed.** `origin/main` is still
at `9912364` (Release 1.3.1). The working tree is clean of code changes. Nothing
has been deployed — not terraform, not the backend, not web, not a build.

The three features here are independent of each other, but the first one has a
**release-ordering constraint that is the single most important thing on this
page** (§4). Read that before pushing anything.

---

## 1. Commits, oldest first

| Commit | What | Surfaces |
|---|---|---|
| `27d03fe` | Stop an old app from eating an image it can't show | client |
| `a639953` | Give a note's images somewhere to live | backend + terraform |
| `15602bc` | Put a screenshot in a note | client |
| `86fd8b9` | Close what the review found in the note images | client + backend |
| `67cd9df` | Open an issue without moving the one beside it | client |
| `1c482f9` | Type code into a block, and press Tab | client |

Each message carries its own reasoning and is worth reading before changing
anything it touches. The three features:

**Images in notes** (`27d03fe` → `86fd8b9`). Paste on web (Ctrl+V), pick with
Ctrl+I, paste on a phone, or the new formatting-bar button. A body never carries
bytes and never carries a device path — it carries `<img src="wn-img:<id>">`,
and a `note_images` row says where the bytes are. Bytes go to the same private
S3 bucket copa attachments use, through presigned URLs.

**Issue grids deal into columns** (`67cd9df`). Expanding an issue card used to
push the adjacent column's cards down, because the grid was laid out as rows and
a row is as tall as its tallest cell. Both issue screens now deal item *i* into
column *i % columns*.

**Code blocks and Tab** (`1c482f9`). ``` on an empty line makes a real block;
Tab indents anywhere in the body. Stored as `<codeblock>`, the native tag.

---

## 2. Verified on this tree

- `npx tsc --noEmit` — clean
- `npm test` (vitest) — **1177 passed, 79 files**
- `npx playwright test` — **12/12**, run against a warm Metro
- `npx expo lint` — no new problems in touched files
- backend `pytest` — the 7 new tests in `backend/tests/test_sync_note_images.py`
  pass, mutation-checked
- web bundle fetched from Metro and confirmed to contain `tabIndent`,
  `codeblock`, `enableTabIndentation`, `extension-code-block`

Every new test was mutation-checked (break the code, confirm red, restore).
Two caught real bugs that way; see §3.

> Playwright normally can't run on this machine — a cold Metro bundle on Windows
> exceeds the 60s per-test timeout, which is why `CLAUDE.md` says don't. It ran
> here only because Metro was already warm from the bundle check. **That is not
> a general licence**; on a cold tree, still let CI do it.

---

## 3. The code review that already landed

`86fd8b9` closes eleven findings from a review of the image work. Two of them
destroyed content:

- **An image-only note or copy block was deleted on unmount.** Both emptiness
  rules asked `htmlToPlainText(body).length === 0`, which strips tags — so a
  body holding nothing but a pasted screenshot read as empty. A note went to the
  trash; a copy block went for good, since copa has no trash.
- **The `<img>` regex truncated at a `>` inside a quoted attribute**, corrupting
  bodies app-wide on every serialize.

`1c482f9` later generalised the first fix into `hasNonTextContent()` in
`html-text.ts`, because an empty-on-purpose code block has the same problem.
**If you add another kind of content that flattens to no text, add it to that
regex** — there are three call sites that will otherwise delete it.

---

## 4. Release order — read this before pushing

`27d03fe` is a **preservation release**, and it is not decorative. Every client
already in the field builds its web editor from an explicit node list with no
image in it, so TipTap parses an `<img>` away at seed; the editor is
uncontrolled, so the next keystroke writes the body back without it, and
last-writer-wins carries that deletion to every device. The only trace would be
an orphaned S3 object.

That commit was written to ship **first, alone**, and to have time to reach
people before anything could create an image. As of this pause it sits in the
same unpushed run as `15602bc`, which is what creates them. So there is a
decision to make, and it is the user's:

- **(a)** Push `27d03fe` (plus a version bump) on its own, let it saturate web
  and a mobile build, then push the rest. This is what the commit intends.
- **(b)** Push all six together and accept that a device that hasn't updated can
  eat an image pasted from a device that has.

Option (b) is only tolerable if this account is effectively single-user across
devices you control and you update them all promptly. Don't make that call
silently.

**Deploy order, whichever is chosen:**

1. **Hand-run `terraform apply`.** `terraform/iam.tf` grants `s3:DeleteObject`
   narrowed to the `note-images/*` prefix. CI never runs terraform. Without it
   the purge logs an `AccessDenied` for every object it tries to reclaim.
2. **Backend deploy** — push to `main` touching `backend/**` triggers GitHub
   Actions via OIDC. Carries alembic `0016_note_images` and the
   `_PRESERVE_IF_NULL` rules for `remote_key`.
3. **Verify** the backend is actually serving the new schema before a client
   that depends on it reaches anyone.
4. **Then clients.** Web via Expo export → wrangler (and *grep `dist` for
   `localhost:8000`, must be 0* — see the web-export bug in memory). Mobile:
   `expo-image-manipulator` is a **new native module**, so inserting an image on
   a phone needs an **EAS build, not an OTA**.

---

## 5. Version

`notes-app/app.json` and `notes-app/package.json` are both still **1.3.1**,
which is what `origin/main` is at. The pre-push hook will abort with *"shipped
code changed but the app version is still 1.3.1"*. Bump before pushing — the
`version-bumper` agent does exactly this and nothing else.

Note the display-vs-runtime rule: `1.3.1` displays, `1.3` is the derived OTA
boundary, and the gate lives in **both** `.githooks/pre-push` and
`tests.yml` — the CI copy is the one that bites.

---

## 6. Open, deliberately

Not bugs to be fixed on sight; each is a decision with a reason.

**Images**

- An image whose bytes haven't downloaded yet renders as the platform's
  **broken-image glyph**. A designed placeholder would be better. What must not
  change is that the tag stays in the document — a broken picture someone can
  see beats a silent deletion they can't.
- Only **width** is bounded (2048px). A tall, narrow image can still be very
  tall in the body. No height cap yet.
- An image is collected when **no body mentions it any more**, not when it's
  deleted from one, and a tombstone is only a hint — a referenced-but-tombstoned
  image comes back. This is load-bearing against last-writer-wins; don't
  "simplify" it into delete-on-removal.

**Code blocks**

- **A phone cannot create one.** `react-native-enriched` has no markdown input
  rules, so ``` there stays three backticks. It renders and edits a block that
  already exists. Making one needs either a formatting-bar button — *the user
  was asked and declined it* — or a patch to the native editor plus an EAS
  build. Don't add the button without asking again.
- **Tab is web-only**; a soft keyboard has no Tab key. On web, Tab no longer
  moves focus out of the body, so **Escape now blurs the editor** as the
  keyboard escape hatch.
- The outbound codeblock transform in `rich-html.web.ts` runs **before** the
  whitespace walker on purpose, so indentation is pinned as `&nbsp;` exactly the
  way native stores it. Moving it after will silently eat indentation on the
  next parse.

**Grids**

- A column list is one row as far as `FlatList` is concerned, so it renders
  every card rather than windowing them. Fine at the sizes these screens hold
  (the GitHub one pages at 100), but a real change for a project type holding
  hundreds of issues.

---

## 7. Loose end from the pause

A `code-reviewer` pass was running against the `1c482f9` diff when this stopped,
and **its result was never seen**. The commit was made on the hook's prompt
because the work was complete and verified, not because the review came back
clean. Re-run it if you want that signal:

> review the working-tree diff for code blocks and Tab in the web editor —
> round-trip fidelity of the `<codeblock>` transforms in `rich-html.web.ts`, the
> Tab shortcut's interaction with tiptap's own Tab handling, and false negatives
> in `hasNonTextContent`.

---

## 8. Next steps

1. Decide (a) or (b) in §4.
2. Bump the version (§5).
3. `terraform apply` by hand, then push, then verify the backend, then clients.
4. EAS build for mobile image insert.
5. Optionally re-run the code review from §7.

## 9. Environment left behind

- Metro on 8081: **killed**.
- Docker Desktop and the `wnotes-test-pg` container: **still up** from the
  backend test run. Stop them if you're done.
- Untracked and unrelated to all of this: `.wrangler/`, `logo/3_2_thumb*.png`,
  and the three earlier handoffs in `docs/`. Never `git add -A` here.
