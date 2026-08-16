#!/usr/bin/env python3
"""Deterministic test-the-test for the repository supply-chain policy."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

CHECKER = Path(__file__).with_name('check_supply_chain.py').resolve()
ACTION_SHA = 'a' * 40
IMAGE_SHA = 'b' * 64

WORKFLOW = f'''name: fixture
on: push
jobs:
  fixture:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16@sha256:{IMAGE_SHA}
    steps:
      - uses: actions/checkout@{ACTION_SHA} # v1.2.3
      - run: npx --yes expo-doctor@1.20.2
      - run: python -m pip install 'pip-audit==2.10.1'
'''
DOCKERFILE = f'FROM python:3.12-slim@sha256:{IMAGE_SHA}\n'


def write_fixture(root: Path, *, workflow: str = WORKFLOW, dockerfile: str = DOCKERFILE) -> None:
    workflow_dir = root / '.github' / 'workflows'
    workflow_dir.mkdir(parents=True, exist_ok=True)
    (workflow_dir / 'fixture.yml').write_text(workflow, encoding='utf-8')
    backend = root / 'backend'
    backend.mkdir(parents=True, exist_ok=True)
    (backend / 'Dockerfile').write_text(dockerfile, encoding='utf-8')


def run_checker(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), '--root', str(root)],
        text=True,
        capture_output=True,
        check=False,
    )


def require_pass(root: Path) -> None:
    result = run_checker(root)
    if result.returncode != 0:
        raise AssertionError(f'valid fixture failed:\n{result.stdout}\n{result.stderr}')


def require_fail(root: Path, marker: str) -> None:
    result = run_checker(root)
    if result.returncode == 0:
        raise AssertionError(f'mutated fixture unexpectedly passed: {marker}')
    output = result.stdout + result.stderr
    if marker not in output:
        raise AssertionError(f'expected marker {marker!r} missing from:\n{output}')


def main() -> int:
    with tempfile.TemporaryDirectory(prefix='financeflow-supply-policy-') as tmp:
        root = Path(tmp)
        write_fixture(root)
        require_pass(root)

        cases = [
            (
                'mutable workflow image',
                WORKFLOW.replace(f'postgres:16@sha256:{IMAGE_SHA}', 'postgres:16'),
                DOCKERFILE,
                'workflow container/service image must be digest-pinned',
            ),
            (
                'mutable Dockerfile base',
                WORKFLOW,
                'FROM python:3.12-slim\n',
                'Dockerfile base image must be digest-pinned',
            ),
            (
                'unversioned expo-doctor',
                WORKFLOW.replace('expo-doctor@1.20.2', 'expo-doctor'),
                DOCKERFILE,
                'expo-doctor execution must use an exact package version',
            ),
            (
                'unversioned pip-audit',
                WORKFLOW.replace("'pip-audit==2.10.1'", 'pip-audit'),
                DOCKERFILE,
                'pip-audit installation must use an exact package version',
            ),
            (
                'mutable action ref',
                WORKFLOW.replace(f'actions/checkout@{ACTION_SHA}', 'actions/checkout@main'),
                DOCKERFILE,
                'must be pinned to a full 40-char commit SHA',
            ),
        ]

        for name, workflow, dockerfile, marker in cases:
            shutil.rmtree(root / '.github')
            shutil.rmtree(root / 'backend')
            write_fixture(root, workflow=workflow, dockerfile=dockerfile)
            require_fail(root, marker)
            print(f'SUPPLY_CHAIN_MUTATION={name}:detected')

    print('SUPPLY_CHAIN_TEST_THE_TEST=pass')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
