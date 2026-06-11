"""add users.firebase_uid

Revision ID: 0002_add_firebase_uid
Revises: 0001_initial
Create Date: 2026-06-10
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_add_firebase_uid"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("firebase_uid", sa.String(), nullable=True))
    op.create_index(
        "ix_users_firebase_uid", "users", ["firebase_uid"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_users_firebase_uid", table_name="users")
    op.drop_column("users", "firebase_uid")
