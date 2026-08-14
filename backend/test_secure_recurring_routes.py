import asyncio
from decimal import Decimal

import pytest
from fastapi import HTTPException

import secure_recurring_routes
from api_models import RecurringBillCreateRequest


class Response:
    def __init__(self, data):
        self.data = data


class InsertQuery:
    def __init__(self, client, payload):
        self.client = client
        self.payload = payload

    def execute(self):
        self.client.inserts.append(self.payload)
        if self.client.insert_error is not None:
            raise self.client.insert_error
        return Response([{"id": "template-1", **self.payload}])


class Table:
    def __init__(self, client):
        self.client = client

    def insert(self, payload):
        return InsertQuery(self.client, payload)


class DataClient:
    def __init__(self, insert_error=None):
        self.insert_error = insert_error
        self.inserts = []

    def table(self, name):
        assert name == "finance_bills"
        return Table(self)


def _request():
    return RecurringBillCreateRequest(
        title="Synthetic monthly bill",
        description="fixture only",
        amount=Decimal("123.45"),
        recurring_day=15,
        frequency="monthly",
    )


def test_create_recurring_bill_passes_same_authenticated_client_to_generator(monkeypatch):
    client = DataClient()
    generation_calls = []
    monkeypatch.setattr(secure_recurring_routes, "get_supabase_client", lambda: client)
    monkeypatch.setattr(
        secure_recurring_routes,
        "generate_recurring_instances_for_client",
        lambda supplied_client: generation_calls.append(supplied_client)
        or {"status": "success", "generated": []},
    )

    response = asyncio.run(secure_recurring_routes.create_recurring_bill_user_scoped(_request()))

    assert len(client.inserts) == 1
    assert client.inserts[0]["amount"] == "123.45"
    assert client.inserts[0]["is_recurring"] is True
    assert generation_calls == [client]
    assert response["status"] == "success"
    assert response["generation"] == {"status": "success", "generated": []}


def test_explicit_generate_route_passes_request_scoped_client(monkeypatch):
    client = DataClient()
    calls = []
    monkeypatch.setattr(secure_recurring_routes, "get_supabase_client", lambda: client)
    monkeypatch.setattr(
        secure_recurring_routes,
        "generate_recurring_instances_for_client",
        lambda supplied_client: calls.append(supplied_client)
        or {"status": "success", "generated": [{"id": "child"}]},
    )

    response = secure_recurring_routes.generate_recurring_instances_user_scoped()

    assert calls == [client]
    assert response["generated"] == [{"id": "child"}]


def test_recurring_route_sanitizes_provider_or_database_error(monkeypatch):
    client = DataClient(insert_error=RuntimeError("provider secret detail"))
    monkeypatch.setattr(secure_recurring_routes, "get_supabase_client", lambda: client)

    with pytest.raises(HTTPException) as captured:
        asyncio.run(secure_recurring_routes.create_recurring_bill_user_scoped(_request()))

    assert captured.value.status_code == 500
    assert captured.value.detail == "Não foi possível criar ou gerar a conta recorrente."
    assert "secret" not in captured.value.detail.lower()
