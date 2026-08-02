"""user_credentials: per-account provider tokens, encrypted at rest

Replaces the single server-wide GitHub/Sentry token for the user-facing plugin
routes. The old arrangement meant every account browsed the operator's repos.

NOTE ON MERGE ORDER — the branch `feat/mocha-theme-account-sync` adds
`0009_user_settings` with the same `down_revision` as this one. Whichever lands
second must be rebased onto the other (change its `down_revision` to the first
one's `revision`), or `alembic upgrade head` finds two heads and the container
fails to boot. Check with `alembic heads` after merging — it must print exactly
one.

Revision ID: 0009_user_credentials
Revises: 0008_resume_versions
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_user_credentials"
down_revision: Union[str, None] = "0008_resume_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_credentials",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("token_encrypted", sa.Text(), nullable=False),
        sa.Column("hint", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "provider"),
    )


def downgrade() -> None:
    op.drop_table("user_credentials")
