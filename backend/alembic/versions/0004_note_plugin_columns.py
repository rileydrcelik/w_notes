"""add notes plugin_type / plugin_config columns

Adds the "plugin note" marker to notes. A plugin note (e.g. a Sentry issues
note) syncs like any other row but renders live content instead of ``body``;
``plugin_type`` flags it and ``plugin_config`` holds the plugin's opaque JSON
(for Sentry, the org/project the note watches). Both are null for ordinary
notes.

Revision ID: 0004_note_plugin_columns
Revises: 0003_copa_file_columns
Create Date: 2026-07-01
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_note_plugin_columns"
down_revision: Union[str, None] = "0003_copa_file_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("notes", sa.Column("plugin_type", sa.String(), nullable=True))
    op.add_column("notes", sa.Column("plugin_config", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("notes", "plugin_config")
    op.drop_column("notes", "plugin_type")
