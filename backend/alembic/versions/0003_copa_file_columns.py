"""add copa_items file attachment columns

Adds the file-attachment metadata that lets copa file blocks sync across
devices. The bytes themselves live in S3 under ``remote_key``; the client keeps
its device-local file paths off the wire.

Revision ID: 0003_copa_file_columns
Revises: 0002_add_firebase_uid
Create Date: 2026-06-18
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_copa_file_columns"
down_revision: Union[str, None] = "0002_add_firebase_uid"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("copa_items", sa.Column("file_name", sa.String(), nullable=True))
    op.add_column("copa_items", sa.Column("mime_type", sa.String(), nullable=True))
    op.add_column("copa_items", sa.Column("file_size", sa.BigInteger(), nullable=True))
    op.add_column("copa_items", sa.Column("remote_key", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("copa_items", "remote_key")
    op.drop_column("copa_items", "file_size")
    op.drop_column("copa_items", "mime_type")
    op.drop_column("copa_items", "file_name")
