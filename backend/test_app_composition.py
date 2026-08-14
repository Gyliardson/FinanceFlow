from pathlib import Path

from auth_middleware import SupabaseAuthMiddleware
from runtime import create_app


BACKEND_DIR = Path(__file__).resolve().parent


def _middleware_classes(app):
    return [getattr(item, "cls", None) for item in app.user_middleware]


def _route_keys(app):
    return sorted(
        (getattr(route, "path", ""), method)
        for route in app.router.routes
        for method in sorted(getattr(route, "methods", None) or ())
    )


def test_factory_returns_distinct_apps_with_identical_route_contract(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")

    first = create_app()
    second = create_app()

    assert first is not second
    assert _route_keys(first) == _route_keys(second)
    assert _middleware_classes(first).count(SupabaseAuthMiddleware) == 1
    assert _middleware_classes(second).count(SupabaseAuthMiddleware) == 1


def test_production_composition_does_not_depend_on_mutating_main_app():
    runtime_source = (BACKEND_DIR / "runtime.py").read_text(encoding="utf-8")

    assert "app as legacy_app" not in runtime_source
    assert "_remove_middleware_classes" not in runtime_source
    assert "_remove_route" not in runtime_source


def test_legacy_shared_api_key_is_not_part_of_production_composition():
    runtime_source = (BACKEND_DIR / "runtime.py").read_text(encoding="utf-8")

    assert "APIKeyMiddleware" not in runtime_source
    assert "API_SECRET_KEY" not in runtime_source
    assert "X-API-KEY" not in runtime_source
