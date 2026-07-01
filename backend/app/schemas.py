"""Pydantic shapes for the sync wire format.

These mirror the client's row shapes (snake_case, epoch-ms timestamps, booleans).
The push/pull endpoints are stubbed this pass, but the contract is defined now so
the client scaffolding and the future merge logic agree on the envelope.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Syncable(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: int
    updated_at: int
    deleted_at: int | None = None


class FolderIn(_Syncable):
    name: str = ""
    parent_id: str | None = None
    favorite: bool = False
    trashed_with_folder_id: str | None = None


class NoteIn(_Syncable):
    title: str = ""
    body: str = ""
    folder_id: str | None = None
    favorite: bool = False
    shared: bool = False
    trashed_with_folder_id: str | None = None


class CopaItemIn(_Syncable):
    label: str = ""
    content: str = ""
    favorite: bool = False
    # File attachment metadata; the bytes live in S3 under ``remote_key``.
    file_name: str | None = None
    mime_type: str | None = None
    file_size: int | None = None
    remote_key: str | None = None


class PushRequest(BaseModel):
    """A batch of local changes the client wants the server to absorb."""

    folders: list[FolderIn] = []
    notes: list[NoteIn] = []
    copa_items: list[CopaItemIn] = []


class PushResponse(BaseModel):
    # The highest server_seq the server holds after this push — becomes the
    # client's next pull cursor.
    server_seq: int


class PullResponse(BaseModel):
    # Rows changed since the client's cursor, plus the new high-water cursor.
    folders: list[FolderIn] = []
    notes: list[NoteIn] = []
    copa_items: list[CopaItemIn] = []
    server_seq: int
