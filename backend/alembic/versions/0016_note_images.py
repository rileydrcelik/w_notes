"""add note_images table

Backs images embedded in a note body. The body carries a reference —
``<img src="wn-img:{id}">`` — and this row says where the bytes are: in S3 under
``remote_key``, exactly like a copa attachment. Bodies sync verbatim to every
device, so they can never carry a device-local path; the indirection is what
makes an image work on the phone that didn't paste it.

Deliberately not scoped to a note, and so with no ``note_id`` column. One id can
be referenced by two bodies (copying a screenshot from one note into another)
and by a copa block, which shares the editor. Ownership by note would make
trashing the first note delete bytes the second still shows.

``remote_key`` and the metadata beside it are nullable, and NULL means "not
uploaded yet, or not heard about yet" rather than "cleared" — which is what lets
``_PRESERVE_IF_NULL`` in ``routers/sync.py`` COALESCE-preserve them. Plain LWW
would let a peer that hasn't pulled the upload stamp erase the only pointer to
the bytes.

Revision ID: 0016_note_images
Revises: 0015_folder_color
Create Date: 2026-09-18
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0016_note_images"
down_revision: Union[str, None] = "0015_folder_color"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "note_images",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("mime_type", sa.String(), nullable=True),
        sa.Column("file_size", sa.BigInteger(), nullable=True),
        sa.Column("width", sa.BigInteger(), nullable=True),
        sa.Column("height", sa.BigInteger(), nullable=True),
        sa.Column("remote_key", sa.String(), nullable=True),
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
    op.create_index("idx_note_images_user_seq", "note_images", ["user_id", "server_seq"])
    # The purge job asks for tombstoned rows across all users, oldest first.
    op.create_index("idx_note_images_deleted", "note_images", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("idx_note_images_deleted", table_name="note_images")
    op.drop_index("idx_note_images_user_seq", table_name="note_images")
    op.drop_table("note_images")
