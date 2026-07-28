"""add finance_sheets table

Backs the ``plugin_type='finance'`` note kind: an interactive spreadsheet whose
whole document (cells, per-cell formatting, formula sources) lives in one opaque
JSON ``data`` column the client owns.

``id`` is the owning note's id rather than a fresh uuid, so a note can never
have two sheets or a sheet none. There is deliberately no FK to ``notes``: sync
applies rows table-by-table with no ordering guarantee between them, so a sheet
can legitimately arrive before the note it belongs to.

One row per sheet, not one per cell. ``push`` upserts rows sequentially, each in
its own savepoint, with a per-user advisory lock held across the batch — under a
per-cell schema a few-hundred-cell paste would hold that lock across a few
hundred round trips and stall the user's other devices.

``data`` is Text rather than JSON/JSONB to match every other opaque blob in this
schema (``folders.config``, ``notes.plugin_config``, ``issues.attrs``): the
server never reads inside it, and SQLite on the client has no JSON type anyway,
so Text keeps both ends identical.

Revision ID: 0008_finance_sheets
Revises: 0007_note_published
Create Date: 2026-07-27
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0008_finance_sheets"
down_revision: Union[str, None] = "0007_note_published"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "finance_sheets",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("data", sa.Text(), nullable=False, server_default="{}"),
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
        "idx_finance_user_seq", "finance_sheets", ["user_id", "server_seq"]
    )


def downgrade() -> None:
    op.drop_index("idx_finance_user_seq", table_name="finance_sheets")
    op.drop_table("finance_sheets")
