"""add notes.embedded — whether the portfolio has this note placed on the site

The first **server-owned** column in the sync stream, and that is the whole
reason it exists separately rather than reusing ``published`` beside it.

``published`` was the app deciding what to put on the site. The website owns
placement now (see ``publisher.collect_publish_actions``), that flag is vestigial
and always false, and it is *client-owned*: every shipped client has it as a
``NOT NULL DEFAULT 0`` column that it selects into every push. Its seat in
``_PRESERVE_IF_NULL`` therefore protects nothing here — that guard keeps a stored
value only when the incoming one is NULL, and these clients send an explicit
``false``. Writing the site's answer into ``published`` would have it wiped by the
next ordinary edit from any device, and wiped account-wide by the anonymous →
account claim, which re-pushes every local row at once.

So ``embedded`` is stripped from the push path entirely — see ``_SERVER_OWNED`` in
``routers/sync.py``, which removes it from the upsert's values so it reaches
neither the INSERT nor the UPDATE branch. A client cannot write it, including a
client that predates it and one that has pulled the row but not the column.

**Nullable with no server default, and that is load-bearing.** Three states, not
two:

* ``NULL``  — nobody has asked the portfolio about this note yet.
* ``true``  — the portfolio answered that it has the note placed.
* ``false`` — the portfolio answered that it does not.

A boolean defaulting to false would spell "the portfolio was unreachable" and
"the portfolio says no" the same way, and an outage would read as every note
being dropped from the site. The publisher writes only on a definite HTTP answer
and leaves the stored value alone otherwise; the nullability is what makes that
distinction expressible.

Revision ID: 0013_note_embedded
Revises: 0012_resume_targets
Create Date: 2026-09-12
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0013_note_embedded"
down_revision: Union[str, None] = "0012_resume_targets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # No server_default: an existing row means "never asked", which is NULL.
    op.add_column("notes", sa.Column("embedded", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("notes", "embedded")
