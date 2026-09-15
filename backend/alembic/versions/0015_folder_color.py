"""add folders.color

A folder's user-chosen accent: ``#rrggbb``, or ``'theme'`` once the person
resets it to the theme default.

Nullable and without a default. NULL means "never set, or pushed by a client
that predates the column", which is what lets sync COALESCE-preserve it (see
``_PRESERVE_IF_NULL`` in ``routers/sync.py``). A server default of ``'theme'``
would have every existing row claim an explicit reset, and the next push from
any device would lay that over a colour chosen on another.

Revision ID: 0015_folder_color
Revises: 0014_issue_duplicate
Create Date: 2026-09-15
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0015_folder_color"
down_revision: Union[str, None] = "0014_issue_duplicate"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("folders", sa.Column("color", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("folders", "color")
