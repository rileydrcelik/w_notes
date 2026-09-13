"""``issues.duplicate_of`` / ``issues.duplicate_dismissed_at`` — the set-once
columns a losing copy of a row must not lose (see ``_MERGE_ONCE`` in
``routers/sync.py``).

Unlike ``notes.embedded`` (`test_sync_embedded.py`), these columns are NOT
server-owned: an ordinary client push carries them, same as any other field.
What makes them different is the merge rule once they are set — first
non-null wins, regardless of ``updated_at`` order — so every test here drives
the real ``POST /sync/push`` / ``GET /sync/pull`` endpoints rather than
poking the database directly.
"""

from __future__ import annotations

import uuid

from test_sync import pull, push


def issue(**overrides) -> dict:
    """A minimal valid issue row. `note_id` stands in for the project's issue
    type; nothing here validates that it actually exists."""
    row = {
        "id": str(uuid.uuid4()),
        "note_id": "type-1",
        "title": "",
        "description": "",
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


async def test_a_push_without_the_new_fields_keeps_stored_values(client, device):
    """An older client that predates duplicate detection round-trips a row
    without either key in its payload at all — not even as an explicit null —
    and must not wipe what an earlier push already recorded."""
    row = issue(updated_at=1_000, duplicate_of="cand-1", duplicate_dismissed_at=5_000)
    await push(client, device, issues=[row])

    old_client_row = {k: v for k, v in row.items() if k not in ("duplicate_of", "duplicate_dismissed_at")}
    old_client_row = {**old_client_row, "title": "edited", "updated_at": 2_000}
    await push(client, device, issues=[old_client_row])

    pulled = (await pull(client, device))["issues"][0]
    assert pulled["title"] == "edited", "the edit itself must still land"
    assert pulled["duplicate_of"] == "cand-1"
    assert pulled["duplicate_dismissed_at"] == 5_000


async def test_pull_carries_both_fields(client, device):
    row = issue(duplicate_of="cand-1", duplicate_dismissed_at=5_000)
    await push(client, device, issues=[row])

    pulled = (await pull(client, device))["issues"][0]

    assert pulled["duplicate_of"] == "cand-1"
    assert pulled["duplicate_dismissed_at"] == 5_000


async def test_a_stale_copy_carrying_duplicate_of_still_lands_and_bumps_seq(client, device):
    """The case `_PRESERVE_IF_NULL` can't cover: a copy of the row that *loses*
    last-writer-wins (older `updated_at`) but is the only one that ever learned
    `duplicate_of`. The main upsert's `WHERE excluded.updated_at >= issues.updated_at`
    skips it outright — this is exactly what the second statement in `_upsert`
    (the "gains" update) exists for, and it must still get the value onto the
    stored row, with a fresh `server_seq` so a pull past the first push's cursor
    actually returns it.
    """
    row = issue(updated_at=2_000, title="original")
    first = await push(client, device, issues=[row])
    cursor = first["server_seq"]

    stale = {**row, "updated_at": 1_000, "title": "stale rewrite", "duplicate_of": "cand-x"}
    second = await push(client, device, issues=[stale])

    assert second["server_seq"] > cursor, "the gains statement must bump server_seq"

    delta = await pull(client, device, since=cursor)
    assert len(delta["issues"]) == 1
    pulled = delta["issues"][0]
    assert pulled["duplicate_of"] == "cand-x"
    # The stale copy's title must NOT have won — only duplicate_of was gained.
    assert pulled["title"] == "original"


async def test_a_newer_push_with_null_does_not_undo_a_stored_dismissal(client, device):
    row = issue(updated_at=1_000, duplicate_dismissed_at=5_000)
    await push(client, device, issues=[row])

    await push(client, device, issues=[{**row, "updated_at": 2_000, "duplicate_dismissed_at": None}])

    pulled = (await pull(client, device))["issues"][0]
    assert pulled["duplicate_dismissed_at"] == 5_000


async def test_a_newer_push_with_a_different_duplicate_of_does_not_replace_the_first(client, device):
    """First non-null wins, not newest: a second device racing to judge the same
    issue must not overwrite the first verdict, however much later it pushes."""
    row = issue(updated_at=1_000, duplicate_of="cand-first")
    await push(client, device, issues=[row])

    await push(client, device, issues=[{**row, "updated_at": 2_000, "duplicate_of": "cand-second"}])

    pulled = (await pull(client, device))["issues"][0]
    assert pulled["duplicate_of"] == "cand-first"


async def test_resending_a_row_with_already_set_fields_costs_no_more_than_an_ordinary_resend(
    client, device, other_device
):
    """Isolates the gains statement's idempotency from an unrelated Postgres
    quirk: an ON CONFLICT ... SET server_seq = nextval(...) consumes a sequence
    value even when its WHERE ends up false, so *any* identical resend bumps
    server_seq by more than zero — duplicate columns or not (verified against a
    plain note in the same session). The real claim here is that a row whose
    set-once fields are already stored costs no MORE to resend than one that
    never had any: the gains statement's own WHERE (`col IS NULL`) is what
    keeps it from matching, and re-bumping, a second time.
    """
    with_dup = issue(duplicate_of="cand-1", duplicate_dismissed_at=5_000)
    without_dup = issue()

    dup_first = await push(client, device, issues=[with_dup])
    dup_second = await push(client, device, issues=[with_dup])

    plain_first = await push(client, other_device, issues=[without_dup])
    plain_second = await push(client, other_device, issues=[without_dup])

    dup_delta = dup_second["server_seq"] - dup_first["server_seq"]
    plain_delta = plain_second["server_seq"] - plain_first["server_seq"]
    assert dup_delta == plain_delta
