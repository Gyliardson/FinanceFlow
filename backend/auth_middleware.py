from collections.abc import Collection

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from authentication import (
    AuthenticationError,
    AuthenticationServiceUnavailable,
    authenticate_bearer_header,
)
from request_context import (
    bind_request_client,
    bind_request_user_id,
    reset_request_client,
    reset_request_user_id,
)


class SupabaseAuthMiddleware(BaseHTTPMiddleware):
    """Authenticate protected requests and bind an RLS-scoped Supabase client."""

    def __init__(self, app, public_paths: Collection[str] = ()):
        super().__init__(app)
        self.public_paths = frozenset(public_paths)

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.public_paths or request.method == "OPTIONS":
            return await call_next(request)

        try:
            session = authenticate_bearer_header(request.headers.get("Authorization"))
        except AuthenticationError:
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized – invalid or expired bearer token."},
                headers={"WWW-Authenticate": "Bearer"},
            )
        except AuthenticationServiceUnavailable:
            return JSONResponse(
                status_code=503,
                content={"detail": "Authentication service temporarily unavailable."},
            )

        client_token = bind_request_client(session.data_client)
        user_token = bind_request_user_id(session.user_id)
        request.state.user_id = session.user_id
        request.state.access_token = session.access_token
        try:
            return await call_next(request)
        finally:
            reset_request_user_id(user_token)
            reset_request_client(client_token)
