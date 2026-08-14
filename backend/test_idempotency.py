from decimal import Decimal

import pytest

from idempotency import (
    IdempotencyPayloadConflictError,
    IdempotencyPersistenceError,
    InvalidIdempotencyKeyError,
    canonical_payload_fingerprint,
    execute_idempotent_rpc,
    validate_idempotency_key,
)


class Response:
    def __init__(self, data):
        self.data = data


class RpcCall:
    def __init__(self, client, rpc_name, params):
        self.client = client
        self.rpc_name = rpc_name
        self.params = params

    def execute(self):
        key = (self.rpc_name, self.params["p_idempotency_key"])
        fingerprint = self.params["p_request_fingerprint"]
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


def execute(client, *, rpc_name, operation_type, key, payload):
    return execute_idempotent_rpc(
        data_client=client,
        rpc_name=rpc_name,
        operation_type=operation_type,
        idempotency_key=key,
        fingerprint_payload=payload,
        rpc_parameters={"p_value": "10.00"},
    )


def test_idempotency_key_validation_is_strict_and_bounded():
    assert validate_idempotency_key("intent-0001") == "intent-0001"
    with pytest.raises(InvalidIdempotencyKeyError):
        validate_idempotency_key(None)
    with pytest.raises(InvalidIdempotencyKeyError):
        validate_idempotency_key("short")
    with pytest.raises(InvalidIdempotencyKeyError):
        validate_idempotency_key("bad key with spaces")


def test_fingerprint_is_canonical_for_mapping_order_and_decimal_money():
    first = canonical_payload_fingerprint(
        "reserve_add",
        {"amount": Decimal("10.00"), "metadata": {"b": 2, "a": 1}},
    )
    second = canonical_payload_fingerprint(
        "reserve_add",
        {"metadata": {"a": 1, "b": 2}, "amount": Decimal("10.00")},
    )
    different = canonical_payload_fingerprint("reserve_add", {"amount": Decimal("10.01")})

    assert first == second
    assert len(first) == 64
    assert first != different


@pytest.mark.parametrize(
    ("rpc_name", "operation_type"),
    [
        ("finance_idempotent_add_reserve", "reserve_add"),
        ("finance_idempotent_add_bill", "bill_create"),
        ("finance_idempotent_add_income", "income_create"),
        ("finance_idempotent_create_recurring_template", "recurring_template_create"),
    ],
)
def test_commit_then_transport_timeout_retry_reuses_durable_result_exactly_once(
    rpc_name,
    operation_type,
):
    client = DurableRpcClient()
    client.timeout_after_next_commit = True
    payload = {"amount": Decimal("10.00"), "label": "same logical intent"}

    with pytest.raises(IdempotencyPersistenceError, match="indeterminate"):
        execute(
            client,
            rpc_name=rpc_name,
            operation_type=operation_type,
            key="logical-intent-0001",
            payload=payload,
        )

    result = execute(
        client,
        rpc_name=rpc_name,
        operation_type=operation_type,
        key="logical-intent-0001",
        payload=payload,
    )

    assert result["status"] == "success"
    assert client.effect_counts[rpc_name] == 1
    assert len(client.operations) == 1


def test_same_key_different_payload_is_a_conflict_not_a_second_effect():
    client = DurableRpcClient()

    execute(
        client,
        rpc_name="finance_idempotent_add_reserve",
        operation_type="reserve_add",
        key="reserve-intent-0001",
        payload={"amount": Decimal("10.00")},
    )

    with pytest.raises(IdempotencyPayloadConflictError):
        execute(
            client,
            rpc_name="finance_idempotent_add_reserve",
            operation_type="reserve_add",
            key="reserve-intent-0001",
            payload={"amount": Decimal("20.00")},
        )

    assert client.effect_counts["finance_idempotent_add_reserve"] == 1


def test_new_key_with_equal_business_payload_is_a_new_user_intent():
    client = DurableRpcClient()
    payload = {"amount": Decimal("10.00")}

    execute(
        client,
        rpc_name="finance_idempotent_add_reserve",
        operation_type="reserve_add",
        key="reserve-intent-0001",
        payload=payload,
    )
    execute(
        client,
        rpc_name="finance_idempotent_add_reserve",
        operation_type="reserve_add",
        key="reserve-intent-0002",
        payload=payload,
    )

    assert client.effect_counts["finance_idempotent_add_reserve"] == 2
