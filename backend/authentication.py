from dataclasses import dataclass

from supabase import Client

from database import get_supabase_auth_client, get_user_supabase_client


class AuthenticationError(ValueError):
    """Raised when a request does not carry a valid Supabase Auth access token."""


@dataclass(frozen=True)
class AuthenticatedSession:
    user_id: str
    access_token: str
    data_client: Client


def extract_bearer_token(authorization: str | None) -> str:
    """Extract one strict Bearer token without accepting alternate auth schemes."""
    if not authorization:
        raise AuthenticationError("Missing bearer token.")

    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token.strip():
        raise AuthenticationError("Invalid bearer token.")
    if " " in token.strip():
        raise AuthenticationError("Invalid bearer token.")
    return token.strip()


def authenticate_bearer_header(authorization: str | None) -> AuthenticatedSession:
    """Validate a user JWT with Supabase Auth and build an RLS-scoped Data API client.

    ``auth.get_user(access_token)`` performs server-side validation against the
    Auth service. Only after that succeeds is the same token attached to the
    PostgREST client so PostgreSQL RLS can evaluate ``auth.uid()``.
    """
    access_token = extract_bearer_token(authorization)
    try:
        auth_response = get_supabase_auth_client().auth.get_user(access_token)
        user = getattr(auth_response, "user", None)
        user_id = str(getattr(user, "id", "") or "")
        if not user_id:
            raise AuthenticationError("Invalid bearer token.")
    except AuthenticationError:
        raise
    except Exception as exc:
        raise AuthenticationError("Invalid or expired bearer token.") from exc

    return AuthenticatedSession(
        user_id=user_id,
        access_token=access_token,
        data_client=get_user_supabase_client(access_token),
    )
