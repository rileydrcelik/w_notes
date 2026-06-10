"""SQLAlchemy models mirroring the client's SQLite schema, scoped per user.

Client ids are client-generated strings, so each table uses a composite primary
key of ``(user_id, id)`` — the same note id from two different devices/users
never collides. Every syncable row carries the soft-delete envelope
(``created_at`` / ``updated_at`` / ``deleted_at`` / ``trashed_with_folder_id``)
plus ``server_seq``, a monotonically increasing per-row stamp that the next pass
will use for cursor-based delta pulls — present now so no migration is needed
later.
"""

from __future__ import annotations

import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    ForeignKey,
    Identity,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _new_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    """An account. Today it is reached only via an anonymous device key, but the
    row is the durable identity: real email/password credentials attach to this
    same ``id`` later, so existing data never has to move."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_new_uuid)
    # First-class credential for the anonymous-device phase. Unique, nullable so
    # a future user could exist with only email/password.
    device_key: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    # Reserved for the future real-auth pass; unused for now.
    email: Mapped[str | None] = mapped_column(String, unique=True)
    password_hash: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now()
    )


class Folder(Base):
    __tablename__ = "folders"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    parent_id: Mapped[str | None] = mapped_column(String)
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    trashed_with_folder_id: Mapped[str | None] = mapped_column(String)

    # Server-assigned, ever-increasing change stamp for cursor-based pulls.
    server_seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)

    __table_args__ = (
        Index("idx_folders_user_seq", "user_id", "server_seq"),
        Index("idx_folders_user_parent", "user_id", "parent_id"),
    )


class Note(Base):
    __tablename__ = "notes"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    folder_id: Mapped[str | None] = mapped_column(String)
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    shared: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    trashed_with_folder_id: Mapped[str | None] = mapped_column(String)

    server_seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)

    __table_args__ = (
        Index("idx_notes_user_seq", "user_id", "server_seq"),
        Index("idx_notes_user_folder", "user_id", "folder_id"),
    )


class CopaItem(Base):
    __tablename__ = "copa_items"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)

    label: Mapped[str] = mapped_column(String, nullable=False, default="")
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The client's copa table has no updated_at/deleted_at today, but sync needs
    # both; defaulting keeps the columns harmless until the client sends them.
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)

    server_seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)

    __table_args__ = (Index("idx_copa_user_seq", "user_id", "server_seq"),)
