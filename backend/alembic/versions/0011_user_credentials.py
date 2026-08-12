"""user_credentials: per-account provider tokens, encrypted at rest

Replaces the single server-wide GitHub/Sentry token for the user-facing plugin
routes. The old arrangement meant every account browsed the operator's repos.

Renumbered from `0009_user_credentials` when this branch merged. It was written
against `0008_resume_versions`, but `0009_user_settings` and
`0010_user_anthropic_key` reached `main` first and are already deployed, so this
chains onto the live head instead. Nothing was released under the old id, which
is why it could be renamed rather than merged with a second head.

Revision ID: 0011_user_credentials
Revises: 0010_user_anthropic_key
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_user_credentials"
down_revision: Union[str, None] = "0010_user_anthropic_key"
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
