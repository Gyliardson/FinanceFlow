from contextvars import ContextVar

from supabase import Client

_request_client: ContextVar[Client | None] = ContextVar(
    "financeflow_request_supabase_client",
    default=None,
)
_request_user_id: ContextVar[str | None] = ContextVar(
    "financeflow_request_user_id",
    default=None,
)


def get_request_client() -> Client | None:
    return _request_client.get()


def get_request_user_id() -> str | None:
    return _request_user_id.get()


def bind_request_client(client: Client):
    return _request_client.set(client)


def bind_request_user_id(user_id: str):
    if not user_id:
        raise ValueError("A non-empty authenticated user id is required.")
    return _request_user_id.set(user_id)


def reset_request_client(token) -> None:
    _request_client.reset(token)


def reset_request_user_id(token) -> None:
    _request_user_id.reset(token)
