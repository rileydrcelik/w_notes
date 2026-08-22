"""add resume_targets (the corpus of past tailorings a new one is retrieved from)

Each row records one job a resume was successfully aimed at: what the person
typed (``company``, ``role``), what a model read out of the posting (``facets``),
and the LaTeX that came back (``source``). Tailoring a resume for a *new* posting
scores the new job against these rows and either reuses one outright, adapts the
closest one, or writes from scratch — so this table is a cache whose entries are
documents rather than answers.

``base_hash`` is what stops that cache going stale, and it is the column most
worth understanding. A stored tailoring was written against the resume as it
stood that day; if the person has since added a job to their resume, handing back
that stored document verbatim would quietly return a resume with their newest
experience missing — the worst thing a semantic cache can do here, and one nobody
would notice until an interview. So the hash of the source that was tailored is
stored beside the result, and a row whose hash no longer matches the document in
hand can never be reused as-is. It can still be *adapted*, which is a model call
that sees the current resume.

Rows are **append-only**: nothing rewrites ``source`` or ``facets`` after the
insert. That is deliberate and it buys something concrete — the unknown-key
preservation dance that `lib/finance/sheet.ts` has to do for a document that gets
parsed and re-serialized simply does not arise for a blob nothing ever round
trips. A row can be tombstoned (someone pruning their corpus), never edited.

``note_id`` deliberately carries **no ForeignKey**, matching ``resume_versions``
and ``issues``: nothing in this schema is ever hard-deleted, so a database
cascade would never fire, while the constraint would impose an ordering
dependency between two independently-upserted sync batches whose order is
unspecified. A corpus row can and does arrive on a fresh device before the note
it names, and it outlives that note when the note is deleted — it is provenance,
not a relationship, and every read path treats "no such note" as ordinary.

Every column here is NOT NULL, which is safe *only* because the whole table is
new — no client can predate a column it has always had. **A column added to this
table later must be nullable and must join ``_PRESERVE_IF_NULL`` in
``routers/sync.py``**, or an older client that cannot send it will null it out on
every device via a normal sync round trip.

Revision ID: 0012_resume_targets
Revises: 0011_user_credentials
Create Date: 2026-08-21
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0012_resume_targets"
down_revision: Union[str, None] = "0011_user_credentials"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "resume_targets",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("note_id", sa.String(), nullable=False),
        # Which family of resumes this tailoring belongs to. Masters are
        # per-folder, so candidates are too: a tailoring written under a
        # backend-engineering folder has no business being offered when
        # tailoring inside a product folder. Empty string is the home screen.
        sa.Column("folder_id", sa.String(), nullable=False),
        sa.Column("company", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        # Opaque to the server, like `finance_sheets.data` and `notes.plugin_config`:
        # scoring happens on the device, against rows sync has already delivered.
        sa.Column("facets", sa.Text(), nullable=False),
        # The posting itself, kept because adapting is a comparison: the model
        # is shown the old job beside the new one and asked what changed.
        sa.Column("job_description", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("base_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("deleted_at", sa.BigInteger(), nullable=True),
        sa.Column(
            "server_seq",
            sa.BigInteger(),
            server_default=sa.text("nextval('sync_seq')"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "id"),
    )
    op.create_index(
        "idx_resume_targets_user_seq", "resume_targets", ["user_id", "server_seq"]
    )
    op.create_index(
        "idx_resume_targets_user_note", "resume_targets", ["user_id", "note_id"]
    )


def downgrade() -> None:
    op.drop_index("idx_resume_targets_user_note", table_name="resume_targets")
    op.drop_index("idx_resume_targets_user_seq", table_name="resume_targets")
    op.drop_table("resume_targets")
