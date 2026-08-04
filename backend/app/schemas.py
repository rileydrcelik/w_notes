"""Pydantic shapes for the sync wire format.

These mirror the client's row shapes (snake_case, epoch-ms timestamps, booleans).
The push/pull endpoints are stubbed this pass, but the contract is defined now so
the client scaffolding and the future merge logic agree on the envelope.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Syncable(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: int
    updated_at: int
    deleted_at: int | None = None


class FolderIn(_Syncable):
    name: str = ""
    parent_id: str | None = None
    favorite: bool = False
    trashed_with_folder_id: str | None = None
    # Folder "kind" marker + opaque JSON config (e.g. a task-manager project's
    # repo + attribute schema). None for ordinary folders.
    kind: str | None = None
    config: str | None = None


class NoteIn(_Syncable):
    title: str = ""
    body: str = ""
    folder_id: str | None = None
    favorite: bool = False
    shared: bool = False
    # Publish-to-website flag. ``None`` (not merely absent) from clients that
    # predate it; the upsert COALESCE-preserves the stored value rather than
    # letting a default silently unpublish. NULL reads as false.
    published: bool | None = None
    trashed_with_folder_id: str | None = None
    # Plugin-note marker + opaque per-plugin config (e.g. Sentry org/project).
    # None for ordinary notes; the live plugin data is fetched separately, not
    # carried here.
    plugin_type: str | None = None
    plugin_config: str | None = None


class CopaItemIn(_Syncable):
    label: str = ""
    content: str = ""
    favorite: bool = False
    # File attachment metadata; the bytes live in S3 under ``remote_key``.
    file_name: str | None = None
    mime_type: str | None = None
    file_size: int | None = None
    remote_key: str | None = None


class IssueIn(_Syncable):
    note_id: str = ""
    # JSON array of issue-type note ids (multi-type). None from clients that
    # predate it; the upsert preserves the stored value on NULL.
    type_ids: str | None = None
    title: str = ""
    description: str = ""
    done: bool = False
    # Opaque attribute-values JSON the client owns ({attrId: value}).
    attrs: str = "{}"
    gh_number: int | None = None
    position: int = 0


class FinanceSheetIn(_Syncable):
    # The whole spreadsheet as opaque JSON the client owns. The server never
    # parses it — see FinanceSheet in models.py for why it is one row, not one
    # row per cell.
    data: str = "{}"


class ResumeVersionIn(_Syncable):
    """One snapshot of a resume's LaTeX source.

    Settled rather than immutable: the version a device is currently on is the
    document being edited, so its `source` is rewritten as the user types. See
    `ResumeVersion` in models.py for what that means for conflicts.

    Nothing here is nullable-for-preservation: the whole table is new, so no
    client can predate a column. **When a column is added later, it must be
    added to `_PRESERVE_IF_NULL` in `routers/sync.py`** — an older client that
    can't send it would otherwise null it out on every device.
    """

    note_id: str = ""
    # What changed, frozen when the snapshot was taken.
    label: str = ""
    # The full LaTeX source at that moment.
    source: str = ""


class UserSettingIn(_Syncable):
    """One account-scoped preference. `id` is the preference name.

    As with `ResumeVersionIn`, nothing here is nullable-for-preservation because
    the whole table is new — **a column added later must go in
    `_PRESERVE_IF_NULL` in `routers/sync.py`**, or an older client that cannot
    send it will null it out on every device.
    """

    # Opaque to the server: it stores and returns whatever the client wrote.
    value: str = ""


class PushRequest(BaseModel):
    """A batch of local changes the client wants the server to absorb.

    Every synced table needs a field here *and* on PullResponse. Pydantic
    ignores fields it doesn't declare, so a table missing from this model is
    accepted with a 200 and silently thrown away — the client clears its dirty
    flags believing the push succeeded.
    """

    folders: list[FolderIn] = []
    notes: list[NoteIn] = []
    copa_items: list[CopaItemIn] = []
    issues: list[IssueIn] = []
    finance_sheets: list[FinanceSheetIn] = []
    resume_versions: list[ResumeVersionIn] = []
    user_settings: list[UserSettingIn] = []


class PushResponse(BaseModel):
    # The highest server_seq the server holds after this push — becomes the
    # client's next pull cursor.
    server_seq: int


class PullResponse(BaseModel):
    # Rows changed since the client's cursor, plus the new high-water cursor.
    folders: list[FolderIn] = []
    notes: list[NoteIn] = []
    copa_items: list[CopaItemIn] = []
    issues: list[IssueIn] = []
    finance_sheets: list[FinanceSheetIn] = []
    resume_versions: list[ResumeVersionIn] = []
    user_settings: list[UserSettingIn] = []
    server_seq: int
