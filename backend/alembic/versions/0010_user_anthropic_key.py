"""add the per-account Anthropic API key columns

The AI endpoints (``/resume/entry``, ``/edit``, ``/tailor``, ``/harden``,
``/job-posting``) used to spend one key for everybody: the operator's, injected
from SSM. That is fine for one person and untenable for a multi-tenant API —
each of those calls runs a frontier model over a whole resume, and the tailor
runs it several times per press. So an account now brings its own key, and the
operator's is reserved for the accounts named in ``ai_owner_emails``.

``anthropic_key_ct`` is Fernet ciphertext (``app/crypto.py``), never plaintext,
and is never returned to a client — not even to the account that stored it.
``anthropic_key_hint`` is the last four characters in the clear, which is what
the settings screen shows so someone can tell which key is saved. It is stored
rather than derived because deriving it would mean decrypting, and drawing a
settings row should not need the key that spends money.

Both nullable, and that is the schema's way of saying an account without a key
is an ordinary account rather than a broken one. Most rows will never have
either: an anonymous device-key user has no email, cannot be an owner, and has
nowhere to type a key.

Revision ID: 0010_user_anthropic_key
Revises: 0009_user_settings
Create Date: 2026-08-10
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0010_user_anthropic_key"
down_revision: Union[str, None] = "0009_user_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("anthropic_key_ct", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("anthropic_key_hint", sa.String(), nullable=True))


def downgrade() -> None:
    # Dropping these destroys every stored key. Nobody's *content* is lost — a
    # key is a credential the owner can re-issue — but they will have to enter
    # one again, so this is not the silent no-op a downgrade usually is.
    op.drop_column("users", "anthropic_key_hint")
    op.drop_column("users", "anthropic_key_ct")
