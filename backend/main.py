"""Compatibility entrypoint for the canonical FinanceFlow FastAPI application.

Production and local operators should prefer ``runtime:create_app --factory``.  This
module intentionally contains no independent routes, middleware, shared-secret auth,
or CORS configuration: legacy ``uvicorn main:app`` invocations resolve to the same
Bearer/RLS-secured composition root instead of exposing a second application surface.
"""

from runtime import create_app


app = create_app()
