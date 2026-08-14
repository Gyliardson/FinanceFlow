import json

import pytest

from idempotency import (
    IdempotencyPayloadConflictError,
    IdempotencyPersistenceError,
    InvalidIdempotencyKeyError,
    execute_idempotent_rpc,
    validate_idempotency_key,
)


class Response:
    def __init__(self, data):
        self.data = data


def _database_logical_payload(rpc_name, params):
    payload = {key: value for key, value in params.items() if key != "p_idempotency_key"}
    if rpc_name == "finance_idempotent_create_recurring_template":
        # The first due date is derived from the financial calendar and is not
        # part of the logical recurring-template identity.
        payload.pop("p_due_date", None)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


class RpcCall:
    def __init__(self, client, rpc_name, params):
        self.client = client
        self.rpc_name = rpc_name
        self.params = params

    def execute(self):
        key = (self.rpc_name, self.params["p_idempotency_key"])
        fingerprint = _database_logical_payload(self.rpc_name, self.params)
        existing = self.client.operations.get(key)
        if existing is not None:
            if existing["fingerprint"] != fingerprint:
                raise RuntimeError("idempotency_key_payload_mismatch")
            return Response(existing["result"])

        # Simulate the database transaction committing both the effect and replay
        # record before a transport timeout hides the response from the backend.
        self.client.effect_counts[self.rpc_name] = self.client.effect_counts.get(self.rpc_name, 0) + 1
        result = {
            "status": "success",
            "data": {"operation": self.rpc_name, "effect": self.client.effect_counts[self.rpc_name]},
        }
        self.client.operations[key] = {"fingerprint": fingerprint, "result": result}
        if self.client.timeout_after_next_commit:
            self.client.timeout_after_next_commit = False
            raise TimeoutError("commit succeeded but response was lost")
        return Response(result)


class DurableRpcClient:
    def __init__(self):
        self.operations = {}
        self.effect_counts = {}
        self.timeout_after_next_commit = False

    def rpc(self, rpc_name, params):
        return RpcCall(self, rpc_name, params)


def execute(client, *, rpc_name, key, value="10.00", due_date="2026-09-05"):
    params = {"p_amount": value}
    if rpc_name == "finance_idempotent_create_recurring_template":
        params.update(
            p_title="Rent",
            p_due_date=due_date,
            p_description=None,
            p_frequency="monthly",
            p_recurring_day=5,
        )
    return execute_idempotent_rpc(
        data_client=client,
        rpc_name=rpc_name,
        idempotency_key=key,
        rpc_parameters=params,
    )


def test_idempotency_key_validation_is_strict_and_bounded():
    assert validate_idempotency_key("intent-0001") == "intent-0001"
    with pytest.raises(InvalidIdempotencyKeyError):
        validate_idempotency_key(None)
    with pytest.raises(InvalidIdempotencyKeyError):
        validate_idempotency_key("short")
    with pytest.raises(InvalidIdempotencyKeyError):
        validate_idempotency_key("bad key with spaces")


@pytest.mark.parametrize(
    "rpc_name",
    [
        "finance_idempotent_add_reserve",
        "finance_idempotent_add_bill",
        "finance_idempotent_add_income",
        "finance_idempotent_create_recurring_template",
    ],
)
def test_commit_then_transport_timeout_retry_reuses_durable_result_exactly_once(rpc_name):
    client = DurableRpcClient()
    client.timeout_after_next_commit = True

    with pytest.raises(IdempotencyPersistenceError, match="indeterminate"):
        execute(client, rpc_name=rpc_name, key="logical-intent-0001")

    result = execute(client, rpc_name=rpc_name, key="logical-intent-0001")

    assert result["status"] == "success"
    assert client.effect_counts[rpc_name] == 1
    assert len(client.operations) == 1


def test_same_key_different_payload_is_a_conflict_not_a_second_effect():
    client = DurableRpcClient()

    execute(
        client,
        rpc_name="finance_idempotent_add_reserve",
        key="reserve-intent-0001",
        value="10.00",
    )

    with pytest.raises(IdempotencyPayloadConflictError):
        execute(
            client,
            rpc_name="finance_idempotent_add_reserve",
            key="reserve-intent-0001",
            value="20.00",
        )

    assert client.effect_counts["finance_idempotent_add_reserve"] == 1


def test_recurring_retry_ignores_newly_derived_due_date_for_same_logical_intent():
    client = DurableRpcClient()

    first = execute(
        client,
        rpc_name="finance_idempotent_create_recurring_template",
        key="recurring-intent1",
        due_date="2026-09-05",
    )
    replay = execute(
        client,
        rpc_name="finance_idempotent_create_recurring_template",
        key="recurring-intent1",
        due_date="2026-10-05",
    )

    assert replay == first
    assert client.effect_counts["finance_idempotent_create_recurring_template"] == 1


def test_new_key_with_equal_business_payload_is_a_new_user_intent():
    client = DurableRpcClient()

    execute(
        client,
        rpc_name="finance_idempotent_add_reserve",
        key="reserve-intent-0001",
        value="10.00",
    )
    execute(
        client,
        rpc_name="finance_idempotent_add_reserve",
        key="reserve-intent-0002",
        value="10.00",
    )

    assert client.effect_counts["finance_idempotent_add_reserve"] == 2
