from contextvars import ContextVar

from supabase import Client

_request_client: ContextVar[Client | None] = ContextVar(
    "financeflow_request_supabase_client",
    default=None,
)


def get_request_client() -> Client | None:
    return _request_client.get()


def bind_request_client(client: Client):
    return _request_client.set(client)


def reset_request_client(token) -> None:
    _request_client.reset(token)
