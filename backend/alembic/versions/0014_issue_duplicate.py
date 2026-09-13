"""add issues.duplicate_of and issues.duplicate_dismissed_at

When the model titles a new issue it also judges whether it duplicates an
earlier issue in the same project. ``duplicate_of`` is that issue's id;
``duplicate_dismissed_at`` is when the person said it isn't one.

Both are set once and never cleared, which is what lets sync merge them as
"first non-null wins" regardless of ``updated_at`` (see ``_MERGE_ONCE`` in
``routers/sync.py``). Nullable and without a default for the same reason: a
client that predates the columns pushes NULL, meaning "I don't know", and a
default would have it push a confident value instead.

Revision ID: 0014_issue_duplicate
Revises: 0013_note_embedded
Create Date: 2026-09-13
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0014_issue_duplicate"
down_revision: Union[str, None] = "0013_note_embedded"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("issues", sa.Column("duplicate_of", sa.String(), nullable=True))
    op.add_column("issues", sa.Column("duplicate_dismissed_at", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("issues", "duplicate_dismissed_at")
    op.drop_column("issues", "duplicate_of")
