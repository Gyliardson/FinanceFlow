from unittest.mock import Mock

from request_context import bind_request_client, get_request_client, reset_request_client


def test_request_client_defaults_to_none():
    assert get_request_client() is None


def test_request_client_binding_is_reversible():
    client = Mock(name="user_scoped_client")

    token = bind_request_client(client)
    try:
        assert get_request_client() is client
    finally:
        reset_request_client(token)

    assert get_request_client() is None


def test_nested_binding_restores_previous_client():
    outer = Mock(name="outer_client")
    inner = Mock(name="inner_client")

    outer_token = bind_request_client(outer)
    try:
        inner_token = bind_request_client(inner)
        try:
            assert get_request_client() is inner
        finally:
            reset_request_client(inner_token)
        assert get_request_client() is outer
    finally:
        reset_request_client(outer_token)

    assert get_request_client() is None
