"""Owner-scoped bill read handlers with receipt-data minimization.

Private object paths and historical durable receipt URLs are storage concerns and
must not cross the ordinary bill-read API boundary. The mobile client receives
only enough state to decide whether explicit short-lived receipt access is
available or a legacy row still requires reconciliation.
"""

from fastapi import HTTPException

from database import get_supabase_client

_RECEIPT_INTERNAL_FIELDS = {"receipt_path", "receipt_url"}


def serialize_bill_for_client(row: dict) -> dict:
    """Remove durable receipt locators while preserving explicit UI state."""
    result = {key: value for key, value in row.items() if key not in _RECEIPT_INTERNAL_FIELDS}
    has_private_receipt = bool(row.get("receipt_path"))
    result["has_receipt"] = has_private_receipt
    result["legacy_receipt_requires_reconciliation"] = bool(
        row.get("receipt_url") and not has_private_receipt
    )
    return result


def _serialize_rows(rows) -> list[dict]:
    return [serialize_bill_for_client(row) for row in (rows or [])]


async def get_bills():
    try:
        response = (
            get_supabase_client()
            .table("finance_bills")
            .select("*")
            .order("due_date", desc=True)
            .execute()
        )
        return {"data": _serialize_rows(response.data)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_pending_bills():
    """Return owner-scoped unpaid bills that are eligible for payment."""
    try:
        response = (
            get_supabase_client()
            .table("finance_bills")
            .select("*")
            .in_("status", ["pending", "overdue"])
            .eq("is_recurring", False)
            .order("due_date", desc=False)
            .execute()
        )
        return {"data": _serialize_rows(response.data)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_recurring_bills():
    try:
        response = (
            get_supabase_client()
            .table("finance_bills")
            .select("*")
            .eq("is_recurring", True)
            .order("recurring_day", desc=False)
            .execute()
        )
        return {"data": _serialize_rows(response.data)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_bill_detail(bill_id: str):
    """Return a bill and only structurally linked recurring history.

    Ordinary one-off bills do not have a stored relationship to other rows, so
    description similarity must never be treated as authoritative history.
    """
    try:
        supabase = get_supabase_client()
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")

        bill = bill_resp.data[0]
        parent_id = bill.get("parent_bill_id")
        related = []
        if parent_id:
            siblings = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", parent_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = [row for row in (siblings.data or []) if row["id"] != bill_id]
        elif bill.get("is_recurring"):
            children = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", bill_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = children.data or []

        return {
            "bill": serialize_bill_for_client(bill),
            "history": _serialize_rows(related),
            "history_count": len(related),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
