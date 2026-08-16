#!/usr/bin/env python3
"""Deterministic representation-aware test-the-test for the production supply-chain checker."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import check_supply_chain as production_checker

CHECKER = Path(production_checker.__file__).resolve()
ACTION_SHA = "a" * 40
IMAGE_SHA = "b" * 64
PARSER_REQUIREMENT = (
    "PyYAML==6.0.3 "
    "--hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc"
)
DOCKERFILE = f"FROM python:3.12-slim@sha256:{IMAGE_SHA}\n"

CONTROL_JOB = f"""
  control:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16@sha256:{IMAGE_SHA}
    steps:
      - uses: actions/setup-python@{ACTION_SHA} # v7.0.0
"""

HEADER = """name: semantic-fixture
on: push
jobs:
"""


@dataclass(frozen=True)
class Case:
    name: str
    workflow: str | None
    should_pass: bool
    marker: str = ""
    dockerfile: str = DOCKERFILE


def workflow(fragment: str, *, with_control: bool = True) -> str:
    return HEADER + (CONTROL_JOB if with_control else "") + fragment


def target_steps(*steps: str) -> str:
    body = "\n".join(f"      {line}" for step in steps for line in step.splitlines())
    return f"""
  target:
    runs-on: ubuntu-latest
    steps:
{body}
"""


def write_fixture(
    root: Path,
    *,
    workflow_text: str | None,
    dockerfile: str = DOCKERFILE,
) -> None:
    scripts = root / ".github" / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    (scripts / "requirements-supply-chain.txt").write_text(
        PARSER_REQUIREMENT + "\n", encoding="utf-8"
    )

    if workflow_text is not None:
        workflow_dir = root / ".github" / "workflows"
        workflow_dir.mkdir(parents=True, exist_ok=True)
        (workflow_dir / "fixture.yml").write_text(workflow_text, encoding="utf-8")

    backend = root / "backend"
    backend.mkdir(parents=True, exist_ok=True)
    (backend / "Dockerfile").write_text(dockerfile, encoding="utf-8")


def reset_fixture(
    root: Path,
    *,
    workflow_text: str | None,
    dockerfile: str = DOCKERFILE,
) -> None:
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    write_fixture(root, workflow_text=workflow_text, dockerfile=dockerfile)


def run_checker_subprocess(
    root: Path,
    *,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Use the production CLI only where import-environment isolation is required."""
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(root)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def evaluate_with_production_checker(root: Path) -> tuple[int, str]:
    """Invoke the exact production checker implementation path without a parallel parser."""
    ctx = production_checker.inspect(root)
    output = "\n".join(ctx.errors)
    return (1 if ctx.errors else 0), output


def assert_case(root: Path, case: Case) -> None:
    reset_fixture(root, workflow_text=case.workflow, dockerfile=case.dockerfile)
    returncode, output = evaluate_with_production_checker(root)
    if case.should_pass:
        if returncode != 0:
            raise AssertionError(
                f"{case.name}: valid semantic fixture failed:\n{output}"
            )
        print(f"SUPPLY_CHAIN_CASE={case.name}:pass")
        return

    if returncode == 0:
        raise AssertionError(
            f"{case.name}: mutated fixture unexpectedly passed:\n{output}"
        )
    if case.marker and case.marker not in output:
        raise AssertionError(
            f"{case.name}: expected marker {case.marker!r} missing:\n{output}"
        )
    print(f"SUPPLY_CHAIN_CASE={case.name}:detected")

def main() -> int:
    pinned_step = f"- uses: actions/checkout@{ACTION_SHA} # v7.0.1"
    mutable_step = "- uses: actions/checkout@main"
    flow_pinned_step = (
        f"- {{ uses: actions/checkout@{ACTION_SHA} }} # v7.0.1"
    )
    flow_mutable_step = "- { uses: actions/checkout@main }"
    quoted_flow_mutable = '- { "uses": "actions/checkout@main" }'
    quoted_flow_pinned = (
        f'- {{ "uses": "actions/checkout@{ACTION_SHA}" }} # v7.0.1'
    )

    cases = [
        # 1-5: step uses and representation equivalence
        Case(
            "01-canonical-pinned-step",
            workflow(target_steps(pinned_step)),
            True,
        ),
        Case(
            "02-canonical-mutable-step",
            workflow(target_steps(mutable_step)),
            False,
            "full 40-char commit SHA",
        ),
        Case(
            "03-flow-mutable-step",
            workflow(target_steps(flow_mutable_step)),
            False,
            "full 40-char commit SHA",
        ),
        Case(
            "04-flow-pinned-step",
            workflow(target_steps(flow_pinned_step)),
            True,
        ),
        Case(
            "05-quoted-flow-mutable-step",
            workflow(target_steps(quoted_flow_mutable)),
            False,
            "full 40-char commit SHA",
        ),
        Case(
            "05b-quoted-flow-pinned-step",
            workflow(target_steps(quoted_flow_pinned)),
            True,
        ),
        # 6-8: reusable workflows and local references
        Case(
            "06-external-reusable-mutable",
            workflow(
                """
  target:
    uses: owner/repo/.github/workflows/test.yml@main
"""
            ),
            False,
            "full 40-char commit SHA",
        ),
        Case(
            "07-external-reusable-pinned",
            workflow(
                f"""
  target:
    uses: owner/repo/.github/workflows/test.yml@{ACTION_SHA} # v1.2.3
"""
            ),
            True,
        ),
        Case(
            "08-local-action",
            workflow(target_steps("- uses: ./local/action")),
            True,
        ),
        Case(
            "08b-local-reusable",
            workflow(
                """
  target:
    uses: ./.github/workflows/local.yml
"""
            ),
            True,
        ),
        # 9-10: docker actions
        Case(
            "09-docker-action-mutable",
            workflow(target_steps("- uses: docker://alpine:3.20")),
            False,
            "docker action image must be digest-pinned",
        ),
        Case(
            "10-docker-action-digest",
            workflow(
                target_steps(f"- uses: docker://alpine@sha256:{IMAGE_SHA}")
            ),
            True,
        ),
        # 11-14: service mapping block/flow equivalence
        Case(
            "11-service-canonical-mutable",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:16
    steps:
      - run: echo ok
"""
            ),
            False,
            "must be digest-pinned",
        ),
        Case(
            "12-service-canonical-digest",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres@sha256:{IMAGE_SHA}
    steps:
      - run: echo ok
"""
            ),
            True,
        ),
        Case(
            "13-service-flow-mutable",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    services:
      db: { image: postgres:16 }
    steps:
      - run: echo ok
"""
            ),
            False,
            "must be digest-pinned",
        ),
        Case(
            "14-service-flow-digest",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    services:
      db: {{ image: postgres@sha256:{IMAGE_SHA} }}
    steps:
      - run: echo ok
"""
            ),
            True,
        ),
        # 15-18: job container shorthand/mapping representations
        Case(
            "15-job-container-shorthand-mutable",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    container: node:latest
    steps:
      - run: node --version
"""
            ),
            False,
            "must be digest-pinned",
        ),
        Case(
            "16-job-container-shorthand-digest",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    container: node@sha256:{IMAGE_SHA}
    steps:
      - run: node --version
"""
            ),
            True,
        ),
        Case(
            "17-job-container-mapping-mutable",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    container:
      image: node:latest
    steps:
      - run: node --version
"""
            ),
            False,
            "must be digest-pinned",
        ),
        Case(
            "18-job-container-flow-mapping-mutable",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    container: { image: node:latest }
    steps:
      - run: node --version
"""
            ),
            False,
            "must be digest-pinned",
        ),
        Case(
            "18b-job-container-flow-mapping-digest",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    container: {{ image: node@sha256:{IMAGE_SHA} }}
    steps:
      - run: node --version
"""
            ),
            True,
        ),
        Case(
            "19-malformed-yaml",
            "name: fixture\njobs:\n  x: [\n",
            False,
            "workflow YAML parse failed closed",
        ),
        Case(
            "20-non-string-uses",
            workflow(target_steps("- uses: true")),
            False,
            "must be a literal YAML string",
        ),
        Case(
            "21-non-string-image",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    services:
      db:
        image: 123
    steps:
      - run: echo ok
"""
            ),
            False,
            "must be a literal YAML string",
        ),
        Case(
            "22-dynamic-external-ref",
            workflow(target_steps('- uses: "actions/checkout@${{ github.ref }}"')),
            False,
            "dynamic expression",
        ),
        Case(
            "23-no-workflows",
            None,
            False,
            "no workflow files were discovered",
        ),
        Case(
            "24-pinned-control-cannot-hide-flow-mutable",
            workflow(target_steps(pinned_step, flow_mutable_step), with_control=False),
            False,
            "full 40-char commit SHA",
        ),
        # Preserve pre-existing policies
        Case(
            "25-mutable-dockerfile-base",
            workflow(target_steps(pinned_step)),
            False,
            "Dockerfile base image must be digest-pinned",
            dockerfile="FROM python:3.12-slim\n",
        ),
        Case(
            "26-unversioned-expo-doctor",
            workflow(
                target_steps(
                    pinned_step,
                    "- run: npx --yes expo-doctor",
                )
            ),
            False,
            "expo-doctor execution must use an exact package version",
        ),
        Case(
            "27-exact-expo-doctor",
            workflow(
                target_steps(
                    pinned_step,
                    "- run: npx --yes expo-doctor@1.20.2",
                )
            ),
            True,
        ),
        Case(
            "28-unversioned-pip-audit",
            workflow(
                target_steps(
                    pinned_step,
                    "- run: python -m pip install pip-audit",
                )
            ),
            False,
            "pip-audit installation must use an exact package version",
        ),
        Case(
            "29-exact-pip-audit",
            workflow(
                target_steps(
                    pinned_step,
                    "- run: python -m pip install 'pip-audit==2.10.1'",
                )
            ),
            True,
        ),
        Case(
            "30-mutable-eas-version",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@{ACTION_SHA} # v7.0.1
      - uses: expo/expo-github-action@{ACTION_SHA} # v9.0.0
        with: {{ eas-version: latest }}
"""
            ),
            False,
            "eas-version must be an exact semver",
        ),
        Case(
            "31-exact-eas-version",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@{ACTION_SHA} # v7.0.1
      - uses: expo/expo-github-action@{ACTION_SHA} # v9.0.0
        with: {{ eas-version: 21.8.0 }}
"""
            ),
            True,
        ),
        # Parser/YAML adversarial edge cases
        Case(
            "32-duplicate-security-key",
            workflow(
                target_steps(
                    f"""- uses: actions/checkout@{ACTION_SHA} # v7.0.1
  uses: actions/checkout@main"""
                )
            ),
            False,
            "duplicate YAML key",
        ),
        Case(
            "33-null-uses",
            workflow(target_steps("- uses: null")),
            False,
            "must be a literal YAML string",
        ),
        Case(
            "34-boolean-container-image",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    container: false
    steps:
      - run: echo ok
"""
            ),
            False,
            "must be a literal YAML string",
        ),
        Case(
            "35-anchored-mutable-step",
            workflow(
                target_steps(
                    "- &shared { uses: actions/checkout@main }",
                    "- *shared",
                )
            ),
            False,
            "full 40-char commit SHA",
        ),
        Case(
            "36-anchored-pinned-step",
            workflow(
                target_steps(
                    f"- &shared {{ uses: actions/checkout@{ACTION_SHA} }} # v7.0.1",
                    "- *shared",
                )
            ),
            True,
        ),
        Case(
            "37-yaml-merge-key-fails-closed",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    steps:
      - &base {{ uses: actions/checkout@{ACTION_SHA} }} # v7.0.1
      - {{ <<: *base }}
"""
            ),
            False,
            "YAML merge keys are not accepted",
        ),
        Case(
            "38-human-version-comment-required",
            workflow(
                target_steps(f"- uses: actions/checkout@{ACTION_SHA}")
            ),
            False,
            "human-readable version comment",
        ),
        Case(
            "39-colon-hash-inside-quoted-noncritical-values",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    steps:
      - name: "literal: value # is not a YAML comment"
        uses: actions/checkout@{ACTION_SHA} # v7.0.1
      - run: 'echo "literal: # data"'
"""
            ),
            True,
        ),
        Case(
            "40-flow-service-expression",
            workflow(
                """
  target:
    runs-on: ubuntu-latest
    services:
      db: { image: "${{ matrix.image }}" }
    steps:
      - run: echo ok
"""
            ),
            False,
            "dynamic expression",
        ),
        Case(
            "41-job-reusable-non-string",
            workflow(
                """
  target:
    uses: 42
"""
            ),
            False,
            "must be a literal YAML string",
        ),
        Case(
            "41b-run-expression-is-not-structural-ref",
            workflow(
                target_steps(
                    pinned_step,
                    '- run: echo "CANDIDATE=${{ github.sha }}"',
                )
            ),
            True,
        ),
        Case(
            "41c-defaults-run-mapping-is-not-a-step-command",
            workflow(
                f"""
  target:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@{ACTION_SHA} # v7.0.1
      - run: echo ok
"""
            ),
            True,
        ),
    ]

    with tempfile.TemporaryDirectory(prefix="financeflow-supply-policy-") as tmp:
        root = Path(tmp) / "fixture"
        for case in cases:
            assert_case(root, case)

        # Parser dependency unavailable must turn the production checker red.
        reset_fixture(root, workflow_text=workflow(target_steps(pinned_step)))
        shadow = Path(tmp) / "shadow-missing"
        shadow.mkdir()
        (shadow / "yaml.py").write_text(
            "raise ImportError('synthetic missing PyYAML')\n", encoding="utf-8"
        )
        result = run_checker_subprocess(root, extra_env={"PYTHONPATH": str(shadow)})
        output = result.stdout + result.stderr
        if result.returncode == 0 or "semantic YAML parser unavailable" not in output:
            raise AssertionError(f"42-parser-unavailable: checker did not fail closed:\n{output}"
            )
        print("SUPPLY_CHAIN_CASE=42-parser-unavailable:detected")

        # Wrong parser version must also be red before any workflow can be trusted.
        shadow = Path(tmp) / "shadow-version"
        shadow.mkdir()
        (shadow / "yaml.py").write_text("__version__ = '0.0.0'\n", encoding="utf-8")
        result = run_checker_subprocess(root, extra_env={"PYTHONPATH": str(shadow)})
        output = result.stdout + result.stderr
        if result.returncode == 0 or "parser version mismatch" not in output:
            raise AssertionError(
                f"43-parser-version-mismatch: checker did not fail closed:\n{output}"
            )
        print("SUPPLY_CHAIN_CASE=43-parser-version-mismatch:detected")

        # Parser bootstrap requirements are themselves part of the policy.
        reset_fixture(root, workflow_text=workflow(target_steps(pinned_step)))
        req = root / ".github" / "scripts" / "requirements-supply-chain.txt"
        req.write_text("PyYAML==6.0.3\n", encoding="utf-8")
        returncode, output = evaluate_with_production_checker(root)
        if returncode == 0 or "parser bootstrap must contain exactly" not in output:
            raise AssertionError(
                f"44-parser-bootstrap-hash: checker did not fail closed:\n{output}"
            )
        print("SUPPLY_CHAIN_CASE=44-parser-bootstrap-hash:detected")

        # One end-to-end subprocess proves the CLI uses the same inspect() path.
        reset_fixture(root, workflow_text=workflow(target_steps(pinned_step)))
        result = run_checker_subprocess(root)
        output = result.stdout + result.stderr
        if result.returncode != 0 or "SUPPLY_CHAIN_POLICY=pass" not in output:
            raise AssertionError(f"45-production-cli-wiring failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=45-production-cli-wiring:pass")

    print(f"SUPPLY_CHAIN_MUTATION_CASES={len(cases) + 4}")
    print("SUPPLY_CHAIN_REPRESENTATION_MUTATIONS=block,flow,quoted,alias")
    print("SUPPLY_CHAIN_TEST_THE_TEST=pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
