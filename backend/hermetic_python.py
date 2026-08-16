#!/usr/bin/env python3
"""Hermetic, hash-locked Python bootstrap for release-critical FinanceFlow gates."""
from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

LOCK_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s]+) --hash=sha256:([0-9a-f]{64})$")
DIRECT_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s]+)$")


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


@dataclass(frozen=True)
class LockedPackage:
    name: str
    version: str
    sha256: str


def _meaningful_lines(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"{path}: cannot read UTF-8 lock/requirements file: {exc}") from exc
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def parse_lock(path: Path) -> dict[str, LockedPackage]:
    rows: dict[str, LockedPackage] = {}
    for number, line in enumerate(_meaningful_lines(path), 1):
        match = LOCK_RE.fullmatch(line)
        if not match:
            raise ValueError(
                f"{path}:{number}: every executable package must be exact-version + exactly one sha256 wheel hash; got {line!r}"
            )
        name, version, digest = match.groups()
        key = canonical(name)
        if key in rows:
            raise ValueError(f"{path}:{number}: duplicate normalized package {key!r}")
        rows[key] = LockedPackage(name=name, version=version, sha256=digest)
    if not rows:
        raise ValueError(f"{path}: lock contains no packages")
    return rows


def parse_direct_requirements(path: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    for number, line in enumerate(_meaningful_lines(path), 1):
        match = DIRECT_RE.fullmatch(line)
        if not match:
            raise ValueError(f"{path}:{number}: direct requirement must be an exact name==version pin: {line!r}")
        name, version = match.groups()
        key = canonical(name)
        if key in rows:
            raise ValueError(f"{path}:{number}: duplicate normalized direct package {key!r}")
        rows[key] = version
    if not rows:
        raise ValueError(f"{path}: direct requirements contain no packages")
    return rows


def verify_direct_coverage(direct: Path, lock: Path) -> None:
    direct_rows = parse_direct_requirements(direct)
    locked = parse_lock(lock)
    missing = sorted(set(direct_rows) - set(locked))
    mismatched = sorted(
        key for key, version in direct_rows.items()
        if key in locked and locked[key].version != version
    )
    if missing or mismatched:
        parts: list[str] = []
        if missing:
            parts.append(f"missing from lock: {', '.join(missing)}")
        if mismatched:
            parts.append(
                "version mismatch: " + ", ".join(
                    f"{key} direct={direct_rows[key]} lock={locked[key].version}" for key in mismatched
                )
            )
        raise ValueError(f"{lock}: does not cover {direct} exactly enough: {'; '.join(parts)}")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def python_version() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"


def pip_version() -> str:
    result = subprocess.run(
        [sys.executable, "-m", "pip", "--version"],
        check=True,
        text=True,
        capture_output=True,
    )
    fields = result.stdout.split()
    if len(fields) < 2 or fields[0] != "pip":
        raise RuntimeError(f"unexpected pip --version output: {result.stdout!r}")
    return fields[1]


def install_lock(path: Path, *, force_reinstall: bool = False) -> None:
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-deps",
        "--only-binary=:all:",
        "--require-hashes",
    ]
    if force_reinstall:
        command.append("--force-reinstall")
    command.extend(["-r", str(path)])
    subprocess.run(command, check=True)


def run_pip_check() -> None:
    subprocess.run([sys.executable, "-m", "pip", "check"], check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pip-lock", type=Path, required=True)
    parser.add_argument("--requirements-lock", type=Path, required=True)
    parser.add_argument("--direct-requirements", type=Path)
    parser.add_argument("--expected-python", required=True)
    parser.add_argument("--expected-initial-pip", required=True)
    parser.add_argument("--expected-pip", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()

    try:
        pip_lock = parse_lock(args.pip_lock)
        target_lock = parse_lock(args.requirements_lock)
        if args.direct_requirements:
            verify_direct_coverage(args.direct_requirements, args.requirements_lock)
        if set(pip_lock) != {"pip"}:
            raise ValueError(f"{args.pip_lock}: pip bootstrap lock must contain only pip")
        if pip_lock["pip"].version != args.expected_pip:
            raise ValueError(
                f"{args.pip_lock}: pip lock version {pip_lock['pip'].version} != expected {args.expected_pip}"
            )
        current_python = python_version()
        if current_python != args.expected_python:
            raise ValueError(f"Python {current_python} != expected {args.expected_python}")
        initial_pip = pip_version()
        if initial_pip != args.expected_initial_pip:
            raise ValueError(f"initial pip {initial_pip} != expected {args.expected_initial_pip}")

        print(f"HERMETIC_{args.label}_PYTHON={current_python}")
        print(f"HERMETIC_{args.label}_INITIAL_PIP={initial_pip}")
        print(f"HERMETIC_{args.label}_PIP_LOCK_SHA256={file_sha256(args.pip_lock)}")
        print(f"HERMETIC_{args.label}_TARGET_LOCK_SHA256={file_sha256(args.requirements_lock)}")
        print(f"HERMETIC_{args.label}_TARGET_PACKAGES={len(target_lock)}")

        install_lock(args.pip_lock, force_reinstall=True)
        final_pip = pip_version()
        if final_pip != args.expected_pip:
            raise ValueError(f"final pip {final_pip} != expected {args.expected_pip}")
        print(f"HERMETIC_{args.label}_FINAL_PIP={final_pip}")

        install_lock(args.requirements_lock)
        run_pip_check()
        print(f"HERMETIC_{args.label}=pass")
        return 0
    except (ValueError, RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print(f"HERMETIC_{args.label}=fail", file=sys.stderr)
        print(f"HERMETIC_{args.label}_ERROR={type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
