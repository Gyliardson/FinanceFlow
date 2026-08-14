from datetime import date
from typing import Any

from money import money_to_storage
from recurrence import recurring_due_date


def generate_recurring_instances_for_client(
    data_client: Any,
    *,
    today: date | None = None,
) -> dict[str, Any]:
    """Generate recurring children using only an explicitly supplied RLS client.

    The service never resolves a client from request ContextVars itself. Callers
    must pass the already authenticated Data API client, so execution cannot
    accidentally fall back to anonymous/service-role access after a response.
    PostgreSQL uniqueness remains the final idempotency authority.
    """
    effective_today = today or date.today()
    templates_resp = (
        data_client.table("finance_bills")
        .select("*")
        .eq("is_recurring", True)
        .execute()
    )
    templates = templates_resp.data or []
    if not templates:
        return {"status": "success", "message": "Nenhum template recorrente encontrado.", "generated": []}

    existing_resp = (
        data_client.table("finance_bills")
        .select("description,due_date,parent_bill_id")
        .not_.is_("parent_bill_id", "null")
        .execute()
    )
    existing_instances = {
        (item["parent_bill_id"], str(item["due_date"]))
        for item in (existing_resp.data or [])
    }

    to_insert = []
    for template in templates:
        target_date = recurring_due_date(template.get("recurring_day", 1), effective_today)
        if (template["id"], str(target_date)) in existing_instances:
            continue
        target_suffix = f"{target_date.month:02d}/{target_date.year}"
        to_insert.append(
            {
                "description": f"{template['description']} - {target_suffix}",
                "amount": money_to_storage(template["amount"]),
                "due_date": str(target_date),
                "status": "pending",
                "parent_bill_id": template["id"],
                "is_recurring": False,
            }
        )

    generated = []
    if to_insert:
        result = data_client.table("finance_bills").insert(to_insert).execute()
        generated = result.data or []

    return {
        "status": "success",
        "message": f"{len(generated)} nova(s) instância(s) recorrente(s) gerada(s).",
        "generated": generated,
    }
