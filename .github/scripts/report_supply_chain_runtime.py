#!/usr/bin/env python3
"""Emit and enforce exact runtime/parser versions for the required supply-chain job."""
import sys
import pip
import yaml

EXPECTED_PYTHON = "3.12.13"
EXPECTED_PIP = "26.2.1"
EXPECTED_YAML = "6.0.3"

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
