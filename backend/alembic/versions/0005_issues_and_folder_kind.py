"""add issues table + folder kind/config columns

Introduces the task-manager subsystem's storage. A ``kind='project'`` folder is a
task manager whose ``config`` JSON holds its repo + shared attribute schema; the
individual issues live in a new ``issues`` table, filed under an issue-type note
(``note_id``). Issues sync like every other row (LWW on ``updated_at``, stamped
with ``server_seq`` off the shared ``sync_seq`` sequence).

Revision ID: 0005_issues_and_folder_kind
Revises: 0004_note_plugin_columns
Create Date: 2026-07-13
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005_issues_and_folder_kind"
down_revision: Union[str, None] = "0004_note_plugin_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("folders", sa.Column("kind", sa.String(), nullable=True))
    op.add_column("folders", sa.Column("config", sa.Text(), nullable=True))

    op.create_table(
        "issues",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("note_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("done", sa.Boolean(), nullable=False),
        sa.Column("attrs", sa.Text(), nullable=False),
        sa.Column("gh_number", sa.BigInteger(), nullable=True),
        sa.Column("position", sa.BigInteger(), nullable=False),
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
    op.create_index("idx_issues_user_seq", "issues", ["user_id", "server_seq"])
    op.create_index("idx_issues_user_note", "issues", ["user_id", "note_id"])


def downgrade() -> None:
    op.drop_index("idx_issues_user_note", table_name="issues")
    op.drop_index("idx_issues_user_seq", table_name="issues")
    op.drop_table("issues")
    op.drop_column("folders", "config")
    op.drop_column("folders", "kind")
