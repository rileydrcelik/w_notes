"""add resume_versions (version history for resume notes)

Each row is one immutable snapshot of a resume note's LaTeX source, plus a label
saying what the change was. The screen appends one whenever an entry is added,
edited, or a version is restored, and the resume's history is the rows for its
``note_id`` ordered by ``created_at``.

Rows are appended, and every one carries a client-generated id, so two devices
adding versions offline never collide — both land. Note the limit of that: the
version a device is *currently on* is the document being edited and its ``source``
is rewritten as the user types, so that one row takes ordinary last-writer-wins
like a note body does. Finished versions are never rewritten and cannot conflict.

Every column is NOT NULL here, unlike the columns added by 0006/0007, and that is
safe *only* because the whole table is new — no client can predate a column it has
always had. **A column added to this table later must be nullable and must join
``_PRESERVE_IF_NULL`` in ``routers/sync.py``**, or an older client that cannot
send it will null it out on every device via a normal sync round trip.

No ForeignKey on ``note_id``, matching ``issues``: nothing in this schema is ever
hard-deleted, so a database cascade would never fire, while the constraint would
impose an ordering dependency between two independently-upserted sync batches
whose order is unspecified.

Revision ID: 0008_resume_versions
Revises: 0007_note_published
Create Date: 2026-07-29
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0008_resume_versions"
down_revision: Union[str, None] = "0007_note_published"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "resume_versions",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("note_id", sa.String(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
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
        "idx_resume_versions_user_seq", "resume_versions", ["user_id", "server_seq"]
    )
    op.create_index(
        "idx_resume_versions_user_note", "resume_versions", ["user_id", "note_id"]
    )


def downgrade() -> None:
    op.drop_index("idx_resume_versions_user_note", table_name="resume_versions")
    op.drop_index("idx_resume_versions_user_seq", table_name="resume_versions")
    op.drop_table("resume_versions")
