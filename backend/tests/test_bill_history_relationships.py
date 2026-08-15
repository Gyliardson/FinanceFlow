from types import SimpleNamespace

import pytest

import bill_read_routes


class _Query:
    def __init__(self, client):
        self.client = client
        self.operations = []

    def select(self, value):
        self.operations.append(("select", value))
        return self

    def eq(self, field, value):
        self.operations.append(("eq", field, value))
        return self

    def order(self, field, desc=False):
        self.operations.append(("order", field, desc))
        return self

    def ilike(self, field, value):
        raise AssertionError(f"fuzzy history query must not run: {field} {value}")

    def execute(self):
        self.client.executed.append(self.operations.copy())
        if not self.client.responses:
            raise AssertionError("unexpected finance_bills query")
        return SimpleNamespace(data=self.client.responses.pop(0))


class _Client:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.executed = []

    def table(self, name):
        assert name == "finance_bills"
        return _Query(self)


@pytest.mark.asyncio
async def test_one_off_bill_never_guesses_history_from_description(monkeypatch):
    client = _Client(
        [
            {
                "id": "one-off",
                "description": "Internet_% - 08/2026",
                "parent_bill_id": None,
                "is_recurring": False,
                "receipt_path": "owner/one-off/private.jpg",
                "receipt_url": None,
            }
        ]
    )
    monkeypatch.setattr(bill_read_routes, "get_supabase_client", lambda: client)

    result = await bill_read_routes.get_bill_detail("one-off")

    assert result["history"] == []
    assert result["history_count"] == 0
    assert result["bill"]["has_receipt"] is True
    assert "receipt_path" not in result["bill"]
    assert len(client.executed) == 1
    assert client.executed[0] == [("select", "*"), ("eq", "id", "one-off")]


@pytest.mark.asyncio
async def test_recurring_child_history_uses_explicit_parent_relationship(monkeypatch):
    selected = {
        "id": "child-aug",
        "description": "Internet - 08/2026",
        "parent_bill_id": "template-internet",
        "is_recurring": False,
        "receipt_path": None,
        "receipt_url": None,
    }
    sibling = {
        "id": "child-jul",
        "description": "Internet - 07/2026",
        "parent_bill_id": "template-internet",
        "is_recurring": False,
        "receipt_path": None,
        "receipt_url": None,
    }
    client = _Client([selected], [selected, sibling])
    monkeypatch.setattr(bill_read_routes, "get_supabase_client", lambda: client)

    result = await bill_read_routes.get_bill_detail("child-aug")

    assert [row["id"] for row in result["history"]] == ["child-jul"]
    assert result["history_count"] == 1
    assert client.executed[1] == [
        ("select", "*"),
        ("eq", "parent_bill_id", "template-internet"),
        ("order", "due_date", True),
    ]


@pytest.mark.asyncio
async def test_recurring_template_history_uses_explicit_children(monkeypatch):
    template = {
        "id": "template-internet",
        "description": "Internet",
        "parent_bill_id": None,
        "is_recurring": True,
        "receipt_path": None,
        "receipt_url": None,
    }
    child = {
        "id": "child-aug",
        "description": "Internet - 08/2026",
        "parent_bill_id": "template-internet",
        "is_recurring": False,
        "receipt_path": None,
        "receipt_url": None,
    }
    client = _Client([template], [child])
    monkeypatch.setattr(bill_read_routes, "get_supabase_client", lambda: client)

    result = await bill_read_routes.get_bill_detail("template-internet")

    assert [row["id"] for row in result["history"]] == ["child-aug"]
    assert result["history_count"] == 1
    assert client.executed[1] == [
        ("select", "*"),
        ("eq", "parent_bill_id", "template-internet"),
        ("order", "due_date", True),
    ]
