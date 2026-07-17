"""add issues.type_ids (multi-type issues)

An issue can be filed under several issue-type notes, not just one. ``type_ids``
holds a JSON array of the issue-type note ids it belongs to; ``note_id`` remains
the primary/home type (and is the array's first entry). Nullable so a client
that predates the column can push without it — the sync upsert COALESCE-preserves
the stored value rather than nulling it (see ``_PRESERVE_IF_NULL`` in
``routers/sync.py``). Existing rows keep NULL and read as ``[note_id]`` on the
client (see ``effectiveTypeIds``), so no backfill is needed.

Revision ID: 0006_issue_type_ids
Revises: 0005_issues_and_folder_kind
Create Date: 2026-07-17
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0006_issue_type_ids"
down_revision: Union[str, None] = "0005_issues_and_folder_kind"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("issues", sa.Column("type_ids", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("issues", "type_ids")
