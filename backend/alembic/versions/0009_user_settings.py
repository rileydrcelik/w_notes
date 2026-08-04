"""add user_settings (account-scoped preferences, e.g. theme)

A key-value store that syncs. ``id`` *is* the preference name (``themeKey``) and
``value`` is opaque text the client owns, so a second preference costs a row
rather than another migration and the server never needs to know what any of
them mean.

This is what makes a theme a property of the *account* rather than of each
device. The client keeps a separate, device-local ``settings`` table for its
sync cursor, device key and last-synced uid — facts about one device's
relationship to the server, which would be incoherent to share. Nothing from
that table belongs here.

A preference is a singleton, so every write to one conflicts with the last:
plain last-writer-wins on ``updated_at``, same as everything else, and what a
loser costs here is a colour scheme rather than anyone's writing.

Every column is NOT NULL, which is safe *only* because the whole table is new —
no client can predate a column it has always had. **A column added to this table
later must be nullable and must join ``_PRESERVE_IF_NULL`` in
``routers/sync.py``**, or an older client that cannot send it will null it out
on every device via a normal sync round trip.

Numbered 0009 and parented on ``0008_resume_versions``, the current head. The two
migrations both numbered 0008 are a healed branch, not a pattern to copy — see
that file for why they kept their ids.

Revision ID: 0009_user_settings
Revises: 0008_resume_versions
Create Date: 2026-08-02
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0009_user_settings"
down_revision: Union[str, None] = "0008_resume_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
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
        "idx_user_settings_user_seq", "user_settings", ["user_id", "server_seq"]
    )


def downgrade() -> None:
    op.drop_index("idx_user_settings_user_seq", table_name="user_settings")
    op.drop_table("user_settings")
