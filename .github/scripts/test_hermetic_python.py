#!/usr/bin/env python3
"""Fail-closed tests for the canonical hermetic Python bootstrap helper."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "backend/hermetic_python.py"
PIP_LOCK = ROOT / "backend/requirements-pip-bootstrap.lock"


def load_helper():
    spec = importlib.util.spec_from_file_location("financeflow_hermetic_test", HELPER)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    helper = load_helper()
    with tempfile.TemporaryDirectory(prefix="financeflow-hermetic-test-") as tmp:
        root = Path(tmp)
        bad = root / "bad.lock"
        for label, text in (
            ("unpinned", "demo>=1.0 --hash=sha256:" + "a" * 64 + "\n"),
            ("missing-hash", "demo==1.0\n"),
            ("source", "demo @ https://example.com/demo.tar.gz --hash=sha256:" + "a" * 64 + "\n"),
        ):
            bad.write_text(text, encoding="utf-8")
            try:
                helper.parse_lock(bad)
            except ValueError:
                print(f"HERMETIC_LOCK_{label.upper().replace('-', '_')}=detected")
            else:
                raise AssertionError(f"{label}: invalid lock unexpectedly accepted")

        original = PIP_LOCK.read_text(encoding="utf-8")
        line = next(line for line in original.splitlines() if line and not line.startswith("#"))
        prefix, digest = line.rsplit(":", 1)
        wrong = ("0" if digest[0] != "0" else "1") + digest[1:]
        bad_pip = root / "bad-pip.lock"
        bad_pip.write_text(prefix + ":" + wrong + "\n", encoding="utf-8")
        target = root / "target.lock"
        target.write_text(
            "pip==26.2.1 --hash=sha256:71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e\n",
            encoding="utf-8",
        )
        venv = root / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        py = venv / "bin/python"
        initial = subprocess.run(
            [str(py), "-m", "pip", "--version"], text=True, capture_output=True, check=True
        ).stdout.split()[1]
        cmd = [
            str(py), str(HELPER),
            "--pip-lock", str(bad_pip),
            "--requirements-lock", str(target),
            "--expected-python", f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "--expected-initial-pip", initial,
            "--expected-pip", "26.2.1",
            "--label", "WRONG_HASH",
        ]
        result = subprocess.run(cmd, text=True, capture_output=True, check=False)
        output = result.stdout + result.stderr
        if result.returncode == 0 or "HERMETIC_WRONG_HASH=fail" not in output:
            raise AssertionError(f"wrong hash did not fail closed:\n{output}")
        print("HERMETIC_WRONG_HASH=detected")

    print("HERMETIC_PYTHON_TEST_THE_TEST=pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
