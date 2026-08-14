from unittest.mock import Mock

import pytest

from request_context import (
    bind_request_client,
    bind_request_user_id,
    get_request_client,
    get_request_user_id,
    reset_request_client,
    reset_request_user_id,
)


def test_request_context_defaults_to_none():
    assert get_request_client() is None
    assert get_request_user_id() is None


def test_request_client_binding_is_reversible():
    client = Mock(name="user_scoped_client")

    token = bind_request_client(client)
    try:
        assert get_request_client() is client
    finally:
        reset_request_client(token)

    assert get_request_client() is None


def test_request_user_binding_is_reversible():
    token = bind_request_user_id("11111111-1111-1111-1111-111111111111")
    try:
        assert get_request_user_id() == "11111111-1111-1111-1111-111111111111"
    finally:
        reset_request_user_id(token)

    assert get_request_user_id() is None


def test_request_user_binding_rejects_empty_identity():
    with pytest.raises(ValueError, match="user id"):
        bind_request_user_id("")


def test_nested_binding_restores_previous_context():
    outer = Mock(name="outer_client")
    inner = Mock(name="inner_client")

    outer_client_token = bind_request_client(outer)
    outer_user_token = bind_request_user_id("11111111-1111-1111-1111-111111111111")
    try:
        inner_client_token = bind_request_client(inner)
        inner_user_token = bind_request_user_id("22222222-2222-2222-2222-222222222222")
        try:
            assert get_request_client() is inner
            assert get_request_user_id() == "22222222-2222-2222-2222-222222222222"
        finally:
            reset_request_user_id(inner_user_token)
            reset_request_client(inner_client_token)
        assert get_request_client() is outer
        assert get_request_user_id() == "11111111-1111-1111-1111-111111111111"
    finally:
        reset_request_user_id(outer_user_token)
        reset_request_client(outer_client_token)

    assert get_request_client() is None
    assert get_request_user_id() is None
