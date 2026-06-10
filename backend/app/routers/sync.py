"""Sync endpoints — STUBBED this pass.

Auth and the request/response contract are real and exercised; the merge logic
(upsert-by-(user,id), last-writer-wins on updated_at, cursor pull by server_seq)
is the next pass. Both endpoints validate the caller and shape, then return 501
so a client calling them gets an honest "not implemented yet" rather than a
silent success.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import get_current_user
from app.models import User
from app.schemas import PullResponse, PushRequest, PushResponse

router = APIRouter(prefix="/sync", tags=["sync"])

_NOT_IMPLEMENTED = "Sync merge is not implemented yet (scaffold pass)."


@router.post("/push", response_model=PushResponse)
async def push(
    payload: PushRequest,
    user: User = Depends(get_current_user),
) -> PushResponse:
    # TODO(next pass): upsert each row into (user_id, id), last-writer-wins on
    # updated_at, honoring soft deletes; return the new high-water server_seq.
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=_NOT_IMPLEMENTED
    )


@router.get("/pull", response_model=PullResponse)
async def pull(
    since: int = Query(0, ge=0, description="Last server_seq the client holds"),
    user: User = Depends(get_current_user),
) -> PullResponse:
    # TODO(next pass): return all of this user's rows with server_seq > `since`,
    # plus the new high-water cursor.
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=_NOT_IMPLEMENTED
    )
