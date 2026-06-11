"""initial schema: users, folders, notes, copa_items

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-10
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Global change-stamp sequence shared by every syncable table's server_seq.
    op.execute("CREATE SEQUENCE IF NOT EXISTS sync_seq")

    op.create_table(
        "users",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("device_key", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("password_hash", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_key"),
        sa.UniqueConstraint("email"),
    )
    op.create_index("ix_users_device_key", "users", ["device_key"], unique=True)

    op.create_table(
        "folders",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("parent_id", sa.String(), nullable=True),
        sa.Column("favorite", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("deleted_at", sa.BigInteger(), nullable=True),
        sa.Column("trashed_with_folder_id", sa.String(), nullable=True),
        sa.Column(
            "server_seq",
            sa.BigInteger(),
            server_default=sa.text("nextval('sync_seq')"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "id"),
    )
    op.create_index("idx_folders_user_seq", "folders", ["user_id", "server_seq"])
    op.create_index("idx_folders_user_parent", "folders", ["user_id", "parent_id"])

    op.create_table(
        "notes",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("folder_id", sa.String(), nullable=True),
        sa.Column("favorite", sa.Boolean(), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("deleted_at", sa.BigInteger(), nullable=True),
        sa.Column("trashed_with_folder_id", sa.String(), nullable=True),
        sa.Column(
            "server_seq",
            sa.BigInteger(),
            server_default=sa.text("nextval('sync_seq')"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "id"),
    )
    op.create_index("idx_notes_user_seq", "notes", ["user_id", "server_seq"])
    op.create_index("idx_notes_user_folder", "notes", ["user_id", "folder_id"])

    op.create_table(
        "copa_items",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("favorite", sa.Boolean(), nullable=False),
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
    op.create_index("idx_copa_user_seq", "copa_items", ["user_id", "server_seq"])


def downgrade() -> None:
    op.drop_table("copa_items")
    op.drop_table("notes")
    op.drop_table("folders")
    op.drop_index("ix_users_device_key", table_name="users")
    op.drop_table("users")
    op.execute("DROP SEQUENCE IF EXISTS sync_seq")
