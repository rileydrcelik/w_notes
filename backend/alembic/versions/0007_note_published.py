"""add notes.published column

Marks a note for publication to the public portfolio site. Distinct from
``shared`` (which governs in-app sharing): a note can be shared with a
collaborator without being world-readable on the website, and vice versa.

Nullable with a ``false`` server default, so every existing note is
unpublished — publication is strictly opt-in and a backfill can never
accidentally expose a note that predates the column. NULL reads as false.

Nullable specifically so the column can join ``_PRESERVE_IF_NULL`` in the
sync upsert: a client that predates this field sends no value, and the
COALESCE branch keeps the stored one. Were it NOT NULL, the schema default
(``published=False``) on such a push would silently *unpublish* every note
on every sync from an older device.

Revision ID: 0007_note_published
Revises: 0006_issue_type_ids
Create Date: 2026-07-21
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0007_note_published"
down_revision: Union[str, None] = "0006_issue_type_ids"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "notes",
        sa.Column(
            "published",
            sa.Boolean(),
            nullable=True,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("notes", "published")
