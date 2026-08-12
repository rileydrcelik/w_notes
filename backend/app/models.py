"""SQLAlchemy models mirroring the client's SQLite schema, scoped per user.

Client ids are client-generated strings, so each table uses a composite primary
key of ``(user_id, id)`` — the same note id from two different devices/users
never collides. Every syncable row carries the soft-delete envelope
(``created_at`` / ``updated_at`` / ``deleted_at`` / ``trashed_with_folder_id``)
plus ``server_seq``, a monotonically increasing per-row stamp that the next pass
will use for cursor-based delta pulls — present now so no migration is needed
later.
"""

from __future__ import annotations

import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    ForeignKey,
    Index,
    String,
    Text,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _new_uuid() -> str:
    return str(uuid.uuid4())


# A single global sequence stamps every write (insert *and* update) with an
# ever-increasing server_seq, so a client can pull "everything changed since
# cursor N" with one indexed range scan. Gaps per-user are fine — only order
# matters. The push handler advances it explicitly on updates (the column
# default only fires on insert).
SERVER_SEQ_DEFAULT = text("nextval('sync_seq')")


class User(Base):
    """An account. Today it is reached only via an anonymous device key, but the
    row is the durable identity: real email/password credentials attach to this
    same ``id`` later, so existing data never has to move."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_new_uuid)
    # First-class credential for the anonymous-device phase. Unique, nullable so
    # a signed-in user can exist without ever having had a device key.
    device_key: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    # Firebase Auth subject (uid) once the user signs in with Google/Apple. The
    # device-key user's data is merged into this account on first sign-in.
    firebase_uid: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String, unique=True)
    # Reserved; Firebase owns credentials so we never store password hashes.
    password_hash: Mapped[str | None] = mapped_column(String)
    # The account's own Anthropic API key, so the AI endpoints spend the
    # caller's budget rather than the operator's. Fernet ciphertext — see
    # `app/crypto.py`; the plaintext exists in this process for the length of one
    # outbound call and is never returned to any client, not even the owner's.
    #
    # `..._hint` is the last four characters in the clear, which is all the UI
    # needs to say *which* key is stored. It is a separate column rather than
    # something derived at read time because deriving it means decrypting, and
    # rendering a settings screen should not require the ability to spend money.
    anthropic_key_ct: Mapped[str | None] = mapped_column(Text)
    anthropic_key_hint: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )


class Folder(Base):
    __tablename__ = "folders"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    parent_id: Mapped[str | None] = mapped_column(String)
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Optional folder "kind" marker + opaque JSON config, mirroring notes'
    # plugin_type/plugin_config. ``kind='project'`` marks a task-manager folder;
    # ``config`` holds its repo + shared attribute schema. Null for ordinary
    # folders. The individual issues live in the separate ``issues`` table.
    kind: Mapped[str | None] = mapped_column(String)
    config: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    trashed_with_folder_id: Mapped[str | None] = mapped_column(String)

    # Server-assigned, ever-increasing change stamp for cursor-based pulls.
    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (
        Index("idx_folders_user_seq", "user_id", "server_seq"),
        Index("idx_folders_user_parent", "user_id", "parent_id"),
    )


class Note(Base):
    __tablename__ = "notes"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    folder_id: Mapped[str | None] = mapped_column(String)
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    shared: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Opt-in flag mirroring the note onto the public portfolio site as a post in
    # the "notes" category. Distinct from ``shared`` (in-app sharing) — a note can
    # be shared with a collaborator without being world-readable, and vice versa.
    # Nullable (NULL reads as false) so it can sit in the sync layer's
    # ``_PRESERVE_IF_NULL`` set; see the 0007 migration for why that matters.
    published: Mapped[bool | None] = mapped_column(Boolean, server_default=false())

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    trashed_with_folder_id: Mapped[str | None] = mapped_column(String)

    # Marks a note as a "plugin" note whose content is rendered live rather than
    # from ``body`` (e.g. ``plugin_type='sentry'``). ``plugin_config`` is an
    # opaque JSON string the plugin owns — for Sentry, which org/project the note
    # watches. Both are null for ordinary notes. Only this tiny marker syncs; the
    # live data (issues) is fetched on demand and never enters the pipeline.
    plugin_type: Mapped[str | None] = mapped_column(String)
    plugin_config: Mapped[str | None] = mapped_column(Text)

    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (
        Index("idx_notes_user_seq", "user_id", "server_seq"),
        Index("idx_notes_user_folder", "user_id", "folder_id"),
    )


class CopaItem(Base):
    __tablename__ = "copa_items"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    label: Mapped[str] = mapped_column(String, nullable=False, default="")
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # File attachment metadata. The bytes live in S3 under ``remote_key``; the
    # client's device-local paths (file_uri/thumb_uri) are never synced.
    file_name: Mapped[str | None] = mapped_column(String)
    mime_type: Mapped[str | None] = mapped_column(String)
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    remote_key: Mapped[str | None] = mapped_column(String)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The client's copa table has no updated_at/deleted_at today, but sync needs
    # both; defaulting keeps the columns harmless until the client sends them.
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)

    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (Index("idx_copa_user_seq", "user_id", "server_seq"),)


class Issue(Base):
    """A single issue in a task-manager project. It belongs to an issue-type note
    (``note_id``) inside a ``kind='project'`` folder; the project's shared
    attribute schema lives on that folder's ``config``. Syncs like any other row
    (LWW on ``updated_at``); ``attrs`` is opaque JSON the client owns."""

    __tablename__ = "issues"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    # The issue's primary/home issue-type note (also the first entry of type_ids).
    note_id: Mapped[str] = mapped_column(String, nullable=False, default="")
    # JSON array of every issue-type note this issue is filed under (multi-type).
    # Nullable for cross-version safety; NULL reads as [note_id] on the client.
    type_ids: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Attribute values keyed by attribute id: {attrId: string | number | string[]}.
    attrs: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    # The mirrored GitHub issue number when the type is GitHub-connected, else null.
    gh_number: Mapped[int | None] = mapped_column(BigInteger)
    # Manual ordering within a type.
    position: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)

    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (
        Index("idx_issues_user_seq", "user_id", "server_seq"),
        Index("idx_issues_user_note", "user_id", "note_id"),
    )


class FinanceSheet(Base):
    """The spreadsheet behind a ``plugin_type='finance'`` note.

    ``id`` is the owning note's id — one sheet per note, so there is no way to
    end up with two sheets for one note or an orphan with none. ``data`` is the
    entire document (cells, per-cell formatting, formula sources) as opaque JSON
    the client owns; the server never looks inside it.

    Deliberately one row per sheet rather than one per cell: this router upserts
    rows sequentially under a per-user advisory lock, so a bulk edit across a
    few hundred cells would otherwise hold that lock across a few hundred round
    trips. The cost is whole-document LWW, the same trade note bodies make.
    """

    __tablename__ = "finance_sheets"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    data: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)

    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (Index("idx_finance_user_seq", "user_id", "server_seq"),)


class ResumeVersion(Base):
    """One snapshot of a resume note's LaTeX source, with a label saying what
    changed.

    Rows are appended, but one of them is not yet finished. The version a device
    is currently on is the document being edited, so that row's ``source`` is
    rewritten as the user types (see ``db.updateResumeVersion``); versions nobody
    is on are never touched again.

    That distinction is the whole conflict story, and it is **not** the "cannot
    lose each other's work" guarantee an earlier draft of this docstring claimed.
    Finished versions genuinely cannot conflict — each carries its own
    client-generated id, so two devices' snapshots both land and the only row an
    incoming one ever matches is a byte-identical copy of itself, from a push
    whose response got dropped. But the *current* version is an ordinary
    last-writer-wins row: two devices offline on the same version, both typing,
    keep whichever saved later, exactly as they would for a note body.

    ``note_id`` deliberately carries **no ForeignKey**, matching ``Issue.note_id``
    and for the same reason: nothing in this schema is ever hard-deleted, so a
    database-level cascade would never fire anyway, while an FK would impose an
    ordering dependency between two independently-upserted sync batches whose
    order is unspecified.
    """

    __tablename__ = "resume_versions"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    # The resume note this snapshot belongs to.
    note_id: Mapped[str] = mapped_column(String, nullable=False, default="")
    # What the change was, frozen at write time. Not derived from the note's
    # title, so renaming a resume can't rewrite its own history.
    label: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # The full LaTeX source at this point in the resume's life.
    source: Mapped[str] = mapped_column(Text, nullable=False, default="")

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)

    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (
        Index("idx_resume_versions_user_seq", "user_id", "server_seq"),
        Index("idx_resume_versions_user_note", "user_id", "note_id"),
    )


class UserSetting(Base):
    """One account-scoped preference, e.g. the chosen theme.

    ``id`` *is* the preference name (``themeKey``), so this is a key-value store
    that syncs: a second preference costs a row rather than a migration, and the
    server never needs to know what any of them mean. ``value`` is opaque text
    the client owns.

    Not to be confused with the client's device-local ``settings`` table, which
    holds the sync cursor and device key. Those describe a device's relationship
    to the server and would be incoherent to share between devices; these
    describe the person, and are the point of the exercise.

    A preference is a singleton, so every write to one is a conflict with the
    last: this is plain last-writer-wins on ``updated_at``, and the loser is a
    theme rather than anyone's writing.
    """

    __tablename__ = "user_settings"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    value: Mapped[str] = mapped_column(Text, nullable=False, default="")

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)

    server_seq: Mapped[int] = mapped_column(
        BigInteger, server_default=SERVER_SEQ_DEFAULT, nullable=False
    )

    __table_args__ = (Index("idx_user_settings_user_seq", "user_id", "server_seq"),)


class UserCredential(Base):
    """One provider token belonging to one account (a GitHub PAT, a Sentry API
    token). Stored encrypted; see ``app/crypto.py``.

    **Deliberately not syncable.** It has no ``server_seq``, and the sync router
    neither pushes nor pulls it. A credential is not user content: putting it in
    the delta stream would write every device's copy into local SQLite in
    plaintext, and the whole point of holding it here is that it is encrypted at
    rest in one place. Devices read it implicitly, by the server using it on
    their behalf.

    Keyed ``(user_id, provider)`` — one token per provider per account, so
    saving again replaces rather than accumulating.
    """

    __tablename__ = "user_credentials"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # 'github' | 'sentry'. Kept as a plain string rather than a DB enum so
    # adding a provider is a code change, not a migration.
    provider: Mapped[str] = mapped_column(String, primary_key=True)

    # Fernet ciphertext of the token. Never logged, never returned by any route.
    token_encrypted: Mapped[str] = mapped_column(Text, nullable=False)

    # Last 4 characters of the *plaintext*, kept so the UI can show "…ab12" and
    # let someone confirm which token is saved without the server ever handing
    # the secret back. 4 characters of a 40+ character token is not a meaningful
    # disclosure and is the standard affordance.
    hint: Mapped[str] = mapped_column(String, nullable=False, default="")

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
