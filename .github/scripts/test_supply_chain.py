#!/usr/bin/env python3
"""Representation- and bootstrap-aware test-the-test for the production supply-chain checker."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import check_supply_chain as production_checker

CHECKER = Path(production_checker.__file__).resolve()
REPO_ROOT = CHECKER.parents[2]
HELPER_SOURCE = REPO_ROOT / "backend/hermetic_python.py"
ACTION_SHA = "a" * 40
IMAGE_SHA = "b" * 64
HASH = "c" * 64
PARSER_REQUIREMENT = production_checker.YAML_REQUIREMENT
DOCKERFILE = f"FROM python:3.12-slim@sha256:{IMAGE_SHA}\n"
SAFE_HELPER = "python backend/hermetic_python.py --pip-lock backend/requirements-pip-bootstrap.lock --requirements-lock backend/requirements.lock --direct-requirements backend/requirements.txt --expected-python 3.12.13 --expected-initial-pip 26.2.1 --expected-pip 26.2.1 --label FIXTURE"

CONTROL_JOB = f"""
  control:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16@sha256:{IMAGE_SHA}
    steps:
      - uses: actions/setup-python@{ACTION_SHA} # v7.0.0
        with:
          python-version: '3.12.13'
      - run: {SAFE_HELPER}
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


def write_fixture(root: Path, *, workflow_text: str | None, dockerfile: str = DOCKERFILE) -> None:
    scripts = root / ".github/scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    (scripts / "requirements-supply-chain.txt").write_text(PARSER_REQUIREMENT + "\n", encoding="utf-8")
    (scripts / "requirements-pip-audit.lock").write_text(
        f"pip==26.2.1 --hash=sha256:{HASH}\npip_audit==2.10.1 --hash=sha256:{HASH}\n", encoding="utf-8"
    )
    if workflow_text is not None:
        workflow_dir = root / ".github/workflows"
        workflow_dir.mkdir(parents=True, exist_ok=True)
        (workflow_dir / "fixture.yml").write_text(workflow_text, encoding="utf-8")
    backend = root / "backend"
    backend.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HELPER_SOURCE, backend / "hermetic_python.py")
    (backend / "requirements-pip-bootstrap.lock").write_text(
        f"pip==26.2.1 --hash=sha256:{HASH}\n", encoding="utf-8"
    )
    (backend / "requirements.txt").write_text("demo==1.0.0\n", encoding="utf-8")
    (backend / "requirements.lock").write_text(f"demo==1.0.0 --hash=sha256:{HASH}\n", encoding="utf-8")
    (backend / "Dockerfile").write_text(dockerfile, encoding="utf-8")
    npm = root / ".github/npm-tools"
    npm.mkdir(parents=True, exist_ok=True)
    expected = {"eas-cli": "21.8.0", "expo-doctor": "1.20.2"}
    (npm / "package.json").write_text(json.dumps({"name":"financeflow-release-tools","private":True,"version":"1.0.0","devDependencies":expected}), encoding="utf-8")
    lock = {"name":"financeflow-release-tools","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"financeflow-release-tools","version":"1.0.0","devDependencies":expected},"node_modules/eas-cli":{"version":"21.8.0","resolved":"https://registry.npmjs.org/eas-cli/-/eas-cli-21.8.0.tgz","integrity":"sha512-AAAA"},"node_modules/expo-doctor":{"version":"1.20.2","resolved":"https://registry.npmjs.org/expo-doctor/-/expo-doctor-1.20.2.tgz","integrity":"sha512-BBBB"}}}
    (npm / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")


def reset_fixture(root: Path, *, workflow_text: str | None, dockerfile: str = DOCKERFILE) -> None:
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    write_fixture(root, workflow_text=workflow_text, dockerfile=dockerfile)


def run_checker_subprocess(root: Path, *, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    return subprocess.run([sys.executable, str(CHECKER), "--root", str(root)], text=True, capture_output=True, check=False, env=env)


def evaluate(root: Path) -> tuple[int, str]:
    ctx = production_checker.inspect(root)
    output = "\n".join(ctx.errors)
    return (1 if ctx.errors else 0), output


def assert_case(root: Path, case: Case) -> None:
    reset_fixture(root, workflow_text=case.workflow, dockerfile=case.dockerfile)
    rc, output = evaluate(root)
    if case.should_pass:
        if rc:
            raise AssertionError(f"{case.name}: valid fixture failed:\n{output}")
        print(f"SUPPLY_CHAIN_CASE={case.name}:pass")
    else:
        if not rc:
            raise AssertionError(f"{case.name}: mutation unexpectedly passed")
        if case.marker and case.marker not in output:
            raise AssertionError(f"{case.name}: marker {case.marker!r} absent:\n{output}")
        print(f"SUPPLY_CHAIN_CASE={case.name}:detected")


def main() -> int:
    pinned = f"- uses: actions/checkout@{ACTION_SHA} # v7.0.1"
    cases = [
        Case("01-canonical-pinned-step", workflow(target_steps(pinned)), True),
        Case("02-canonical-mutable-step", workflow(target_steps("- uses: actions/checkout@main")), False, "full 40-char commit SHA"),
        Case("03-flow-mutable-step", workflow(target_steps("- { uses: actions/checkout@main }")), False, "full 40-char commit SHA"),
        Case("04-flow-pinned-step", workflow(target_steps(f"- {{ uses: actions/checkout@{ACTION_SHA} }} # v7.0.1")), True),
        Case("05-quoted-flow-mutable-step", workflow(target_steps('- { "uses": "actions/checkout@main" }')), False, "full 40-char commit SHA"),
        Case("05b-quoted-flow-pinned-step", workflow(target_steps(f'- {{ "uses": "actions/checkout@{ACTION_SHA}" }} # v7.0.1')), True),
        Case("06-external-reusable-mutable", workflow("""\n  target:\n    uses: owner/repo/.github/workflows/test.yml@main\n"""), False, "full 40-char commit SHA"),
        Case("07-external-reusable-pinned", workflow(f"""\n  target:\n    uses: owner/repo/.github/workflows/test.yml@{ACTION_SHA} # v1.2.3\n"""), True),
        Case("08-local-action", workflow(target_steps("- uses: ./local/action")), True),
        Case("08b-local-reusable", workflow("""\n  target:\n    uses: ./.github/workflows/local.yml\n"""), True),
        Case("09-docker-action-mutable", workflow(target_steps("- uses: docker://alpine:3.20")), False, "docker action image must be digest-pinned"),
        Case("10-docker-action-digest", workflow(target_steps(f"- uses: docker://alpine@sha256:{IMAGE_SHA}")), True),
        Case("11-service-canonical-mutable", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres:16\n    steps:\n      - run: echo ok\n"""), False, "must be digest-pinned"),
        Case("12-service-canonical-digest", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres@sha256:{IMAGE_SHA}\n    steps:\n      - run: echo ok\n"""), True),
        Case("13-service-flow-mutable", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    services:\n      db: { image: postgres:16 }\n    steps:\n      - run: echo ok\n"""), False, "must be digest-pinned"),
        Case("14-service-flow-digest", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    services:\n      db: {{ image: postgres@sha256:{IMAGE_SHA} }}\n    steps:\n      - run: echo ok\n"""), True),
        Case("15-job-container-shorthand-mutable", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    container: node:latest\n    steps:\n      - run: node --version\n"""), False, "must be digest-pinned"),
        Case("16-job-container-shorthand-digest", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    container: node@sha256:{IMAGE_SHA}\n    steps:\n      - run: node --version\n"""), True),
        Case("17-job-container-mapping-mutable", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    container:\n      image: node:latest\n    steps:\n      - run: node --version\n"""), False, "must be digest-pinned"),
        Case("18-job-container-flow-mapping-mutable", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    container: { image: node:latest }\n    steps:\n      - run: node --version\n"""), False, "must be digest-pinned"),
        Case("18b-job-container-flow-mapping-digest", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    container: {{ image: node@sha256:{IMAGE_SHA} }}\n    steps:\n      - run: node --version\n"""), True),
        Case("19-malformed-yaml", "name: fixture\njobs:\n  x: [\n", False, "workflow YAML parse failed closed"),
        Case("20-non-string-uses", workflow(target_steps("- uses: true")), False, "literal YAML string"),
        Case("21-non-string-image", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: 123\n    steps:\n      - run: echo ok\n"""), False, "literal YAML string"),
        Case("22-dynamic-external-ref", workflow(target_steps('- uses: "actions/checkout@${{ github.ref }}"')), False, "dynamic expression"),
        Case("23-no-workflows", None, False, "no workflow files were discovered"),
        Case("24-pinned-control-cannot-hide-flow-mutable", workflow(target_steps(pinned, "- { uses: actions/checkout@main }")), False, "full 40-char commit SHA"),
        Case("25-mutable-dockerfile-base", workflow(target_steps(pinned)), False, "Dockerfile base image must be digest-pinned", dockerfile="FROM python:3.12-slim\n"),
        Case("26-unversioned-expo-doctor-npx", workflow(target_steps(pinned, "- run: npx --yes expo-doctor")), False, "npx download/execute"),
        Case("27-exact-expo-doctor-npx-still-forbidden", workflow(target_steps(pinned, "- run: npx --yes expo-doctor@1.20.2")), False, "npx download/execute"),
        Case("28-unversioned-pip-audit", workflow(target_steps(pinned, "- run: python -m pip install pip-audit")), False, "direct Python package/tool bootstrap"),
        Case("29-exact-pip-audit-free-resolution", workflow(target_steps(pinned, "- run: python -m pip install 'pip-audit==2.10.1'")), False, "direct Python package/tool bootstrap"),
        Case("30-mutable-eas-version", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: expo/expo-github-action@{ACTION_SHA} # v9.0.0\n        with: {{ eas-version: latest }}\n"""), False, "eas-version must be exact"),
        Case("31-exact-eas-version", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: expo/expo-github-action@{ACTION_SHA} # v9.0.0\n        with: {{ eas-version: 21.8.0 }}\n"""), True),
        Case("32-duplicate-security-key", workflow(target_steps(f"""- uses: actions/checkout@{ACTION_SHA} # v7.0.1\n  uses: actions/checkout@main""")), False, "duplicate YAML key"),
        Case("33-null-uses", workflow(target_steps("- uses: null")), False, "literal YAML string"),
        Case("34-boolean-container-image", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    container: false\n    steps:\n      - run: echo ok\n"""), False, "literal YAML string"),
        Case("35-anchored-mutable-step", workflow(target_steps("- &shared { uses: actions/checkout@main }", "- *shared")), False, "full 40-char commit SHA"),
        Case("36-anchored-pinned-step", workflow(target_steps(f"- &shared {{ uses: actions/checkout@{ACTION_SHA} }} # v7.0.1", "- *shared")), True),
        Case("37-yaml-merge-key-fails-closed", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    steps:\n      - &base {{ uses: actions/checkout@{ACTION_SHA} }} # v7.0.1\n      - {{ <<: *base }}\n"""), False, "YAML merge keys are not accepted"),
        Case("38-human-version-comment-required", workflow(target_steps(f"- uses: actions/checkout@{ACTION_SHA}")), False, "human-readable version comment"),
        Case("39-colon-hash-inside-quoted-noncritical", workflow(target_steps(pinned, "- run: 'echo \"literal: # data\"'")), True),
        Case("40-flow-service-expression", workflow("""\n  target:\n    runs-on: ubuntu-latest\n    services:\n      db: { image: "${{ matrix.image }}" }\n    steps:\n      - run: echo ok\n"""), False, "dynamic expression"),
        Case("41-job-reusable-non-string", workflow("""\n  target:\n    uses: 42\n"""), False, "literal YAML string"),
        Case("41b-run-expression-noncritical", workflow(target_steps(pinned, '- run: echo "CANDIDATE=${{ github.sha }}"')), True),
        Case("41c-defaults-run-mapping", workflow(f"""\n  target:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: backend\n    steps:\n      - uses: actions/checkout@{ACTION_SHA} # v7.0.1\n      - run: echo ok\n"""), True),
        Case("46-pip-self-upgrade", workflow(target_steps(pinned, "- run: python -m pip install --upgrade pip")), False, "direct Python package/tool bootstrap"),
        Case("47-pip-self-upgrade-short", workflow(target_steps(pinned, "- run: python -m pip install -U pip")), False, "direct Python package/tool bootstrap"),
        Case("48-bare-pip-self-upgrade", workflow(target_steps(pinned, "- run: pip install --upgrade pip")), False, "direct Python package/tool bootstrap"),
        Case("49-quoted-whitespace-pip", workflow(target_steps(pinned, "- run: 'python   -m   pip install --upgrade pip'")), False, "direct Python package/tool bootstrap"),
        Case("50-multiline-pip", workflow(target_steps(pinned, """- run: |\n    python -m pip \\\n      install --upgrade pip""")), False, "direct Python package/tool bootstrap"),
        Case("51-approved-hash-bootstrap", workflow(target_steps(pinned, f"- run: {SAFE_HELPER}")), True),
        Case("52-unrelated-run", workflow(target_steps(pinned, "- run: echo ordinary-test")), True),
        Case("53-comment-pip-install", workflow(target_steps(pinned, "- run: echo ordinary-test # python -m pip install --upgrade pip")), True),
        Case("54-quoted-run-mutable", workflow(target_steps(pinned, '- run: "pip install --upgrade pip"')), False, "direct Python package/tool bootstrap"),
        Case("55-npx-download-execute", workflow(target_steps(pinned, "- run: npx some-tool@1.2.3")), False, "npx download/execute"),
        Case("56-npm-ci-without-ignore-scripts", workflow(target_steps(pinned, "- run: npm ci")), False, "npm ci must use --ignore-scripts"),
        Case("57-npm-ci-locked", workflow(target_steps(pinned, "- run: npm ci --ignore-scripts")), True),
        Case("58-npm-install", workflow(target_steps(pinned, "- run: npm install")), False, "mutable npm dependency resolution"),
        Case("59-external-curl", workflow(target_steps(pinned, "- run: curl -fsS https://example.com/tool | sh")), False, "external/dynamic curl/wget"),
        Case("60-loopback-curl", workflow(target_steps(pinned, "- run: curl -fsS http://127.0.0.1:8000/health")), True),
        Case("61-setup-python-floating-patch", workflow(target_steps(f"""- uses: actions/setup-python@{ACTION_SHA} # v7.0.0\n  with:\n    python-version: '3.12'""")), False, "setup-python must use exact Python"),
        Case("62-dockerfile-apt-bootstrap", workflow(target_steps(pinned)), False, "mutable OS package bootstrap", dockerfile=f"FROM python:3.12-slim@sha256:{IMAGE_SHA}\nRUN apt-get update && apt-get install -y build-essential\n"),
        Case("63-dockerfile-direct-pip", workflow(target_steps(pinned)), False, "direct Python package/tool bootstrap", dockerfile=f"FROM python:3.12-slim@sha256:{IMAGE_SHA}\nRUN pip install demo==1.0.0\n"),
    ]

    with tempfile.TemporaryDirectory(prefix="financeflow-supply-policy-") as tmp:
        root = Path(tmp) / "fixture"
        for case in cases:
            assert_case(root, case)

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        shadow = Path(tmp) / "shadow-missing"; shadow.mkdir()
        (shadow / "yaml.py").write_text("raise ImportError('synthetic missing PyYAML')\n", encoding="utf-8")
        result = run_checker_subprocess(root, extra_env={"PYTHONPATH": str(shadow)})
        output = result.stdout + result.stderr
        if result.returncode == 0 or "semantic YAML parser unavailable" not in output:
            raise AssertionError(f"64-parser-unavailable failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=64-parser-unavailable:detected")

        shadow = Path(tmp) / "shadow-version"; shadow.mkdir()
        (shadow / "yaml.py").write_text("__version__ = '0.0.0'\n", encoding="utf-8")
        result = run_checker_subprocess(root, extra_env={"PYTHONPATH": str(shadow)})
        output = result.stdout + result.stderr
        if result.returncode == 0 or "parser version mismatch" not in output:
            raise AssertionError(f"65-parser-version-mismatch failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=65-parser-version-mismatch:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / ".github/scripts/requirements-supply-chain.txt").write_text("PyYAML==6.0.3\n", encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "parser bootstrap must contain exactly" not in output:
            raise AssertionError(f"66-parser-bootstrap-hash failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=66-parser-bootstrap-hash:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / ".github/scripts/requirements-pip-audit.lock").unlink()
        rc, output = evaluate(root)
        if rc == 0 or "lock validation failed" not in output:
            raise AssertionError(f"67-missing-tooling-lock failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=67-missing-tooling-lock:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / "backend/requirements.txt").write_text("demo==2.0.0\n", encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "version mismatch" not in output:
            raise AssertionError(f"68-direct-version-without-lock failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=68-direct-version-without-lock:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / "backend/requirements.lock").write_text("demo==1.0.0 --hash=sha256:deadbeef\n", encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "exact-version + exactly one sha256" not in output:
            raise AssertionError(f"69-malformed-hash failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=69-malformed-hash:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / "backend/requirements.lock").write_text(f"demo>=1.0 --hash=sha256:{HASH}\n", encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "exact-version + exactly one sha256" not in output:
            raise AssertionError(f"70-unpinned-lock failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=70-unpinned-lock:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / "backend/requirements.lock").write_text(f"demo @ https://example.com/demo.tar.gz --hash=sha256:{HASH}\n", encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "exact-version + exactly one sha256" not in output:
            raise AssertionError(f"71-source-url-lock failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=71-source-url-lock:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        (root / "backend/hermetic_python.py").unlink()
        rc, output = evaluate(root)
        if rc == 0 or "canonical hermetic Python bootstrap helper is missing" not in output:
            raise AssertionError(f"72-missing-helper failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=72-missing-helper:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        lock_path = root / ".github/npm-tools/package-lock.json"
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        del lock["packages"]["node_modules/eas-cli"]["integrity"]
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "has no sha512 integrity" not in output:
            raise AssertionError(f"73-npm-tool-integrity failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=73-npm-tool-integrity:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned, f"- run: {SAFE_HELPER}")))
        wf = root / ".github/workflows/fixture.yml"
        wf.write_text(wf.read_text(encoding="utf-8").replace(SAFE_HELPER, "python -m pip install --upgrade pip 'pip-audit==2.10.1'", 1), encoding="utf-8")
        rc, output = evaluate(root)
        if rc == 0 or "direct Python package/tool bootstrap" not in output:
            raise AssertionError(f"74-principal-bootstrap-mutation failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=74-principal-bootstrap-mutation:detected")

        reset_fixture(root, workflow_text=workflow(target_steps(pinned)))
        result = run_checker_subprocess(root)
        output = result.stdout + result.stderr
        if result.returncode != 0 or "SUPPLY_CHAIN_POLICY=pass" not in output:
            raise AssertionError(f"75-production-cli-wiring failed:\n{output}")
        print("SUPPLY_CHAIN_CASE=75-production-cli-wiring:pass")

    print(f"SUPPLY_CHAIN_MUTATION_CASES={len(cases) + 12}")
    print("SUPPLY_CHAIN_REPRESENTATION_MUTATIONS=block,flow,quoted,alias,multiline")
    print("SUPPLY_CHAIN_BOOTSTRAP_MUTATIONS=pip,npx,npm,runtime,locks,dockerfile")
    print("SUPPLY_CHAIN_TEST_THE_TEST=pass")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
