from datetime import date
from typing import Any


def _rpc_payload(response: Any) -> dict[str, Any] | None:
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    return None


def generate_recurring_instances_for_client(
    data_client: Any,
    *,
    today: date | None = None,
) -> dict[str, Any]:
    """Generate owner-scoped recurring children through the sanctioned DB boundary.

    ``today`` remains accepted for compatibility with deterministic unit callers,
    but production due-date authority now belongs to PostgreSQL private runtime
    configuration. The caller supplies only a parent id; amount, description,
    ownership and next due date are derived from the authoritative template.
    """
    templates_resp = (
        data_client.table("finance_bills")
        .select("id")
        .eq("is_recurring", True)
        .execute()
    )
    templates = templates_resp.data or []
    if not templates:
        return {"status": "success", "message": "Nenhum template recorrente encontrado.", "generated": []}

    generated: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for template in templates:
        parent_id = str(template["id"])
        response = data_client.rpc(
            "finance_generate_recurring_child",
            {"p_parent_bill_id": parent_id},
        ).execute()
        payload = _rpc_payload(response)
        child = payload.get("data") if payload and payload.get("status") == "success" else None
        if not isinstance(child, dict) or not child.get("id"):
            raise RuntimeError("Recurring child RPC did not return authoritative state.")
        child_id = str(child["id"])
        if child_id not in seen_ids:
            seen_ids.add(child_id)
            generated.append(child)

    return {
        "status": "success",
        "message": f"{len(generated)} instância(s) recorrente(s) reconciliada(s).",
        "generated": generated,
    }
