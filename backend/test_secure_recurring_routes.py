import secure_recurring_routes


class DataClient:
    pass


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
