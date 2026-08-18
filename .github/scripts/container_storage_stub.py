#!/usr/bin/env python3
"""Minimal deterministic HTTP double for FinanceFlow container-startup tests."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    mode = "success"

    def _write_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/stub-health":
            self._write_json(200, {"status": "ok", "mode": self.mode})
            return
        self._write_json(404, {"message": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        print(f"STORAGE_STUB_REQUEST=POST {self.path} bytes={len(body)} mode={self.mode}", flush=True)

        if self.path != "/storage/v1/bucket":
            self._write_json(404, {"message": "not found"})
            return
        if self.mode == "fail":
            self._write_json(503, {"message": "synthetic storage unavailable"})
            return

        try:
            request = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(400, {"message": "invalid json"})
            return
        if request.get("id") != "receipts" or request.get("name") != "receipts":
            self._write_json(400, {"message": "unexpected bucket"})
            return
        if request.get("public") is not False:
            self._write_json(400, {"message": "receipts bucket must be private"})
            return

        self._write_json(
            200,
            {
                "id": "receipts",
                "name": "receipts",
                "owner": "financeflow-ci",
                "public": False,
                "file_size_limit": None,
                "allowed_mime_types": None,
                "created_at": "2026-08-16T00:00:00Z",
                "updated_at": "2026-08-16T00:00:00Z",
            },
        )

    def log_message(self, format: str, *args: object) -> None:
        print(f"STORAGE_STUB_HTTP={format % args}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--mode", choices=("success", "fail"), default="success")
    args = parser.parse_args()
    Handler.mode = args.mode
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"STORAGE_STUB_READY=port:{args.port}:mode:{args.mode}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
