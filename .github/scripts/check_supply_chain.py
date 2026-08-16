#!/usr/bin/env python3
"""Fail closed when release/relevant workflow-controlled executable inputs are mutable."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import importlib.util
import json
from pathlib import Path
import re
import shlex
import sys
from typing import Any

YAML_PACKAGE = "PyYAML"
YAML_VERSION = "6.0.3"
YAML_REQUIREMENT = "PyYAML==6.0.3 --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc"
PYTHON_VERSION = "3.12.13"
NODE_VERSION = "22.13.0"
GO_VERSION = "1.23.4"
PIP_VERSION = "26.2.1"
PIP_AUDIT_VERSION = "2.10.1"
EXPO_DOCTOR_VERSION = "1.20.2"
EAS_VERSION = "21.8.0"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST_IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
FROM_RE = re.compile(r"^\s*FROM(?:\s+--platform=[^\s]+)?\s+([^\s]+)", re.I)
STR_TAG = "tag:yaml.org,2002:str"
MERGE_TAG = "tag:yaml.org,2002:merge"


@dataclass
class Inventory:
    workflows: list[str] = field(default_factory=list)
    step_actions: list[str] = field(default_factory=list)
    reusable: list[str] = field(default_factory=list)
    docker_actions: list[str] = field(default_factory=list)
    job_containers: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)
    dockerfile_bases: list[str] = field(default_factory=list)
    python_bootstraps: list[str] = field(default_factory=list)
    npm_ci: list[str] = field(default_factory=list)
    loopback_downloads: list[str] = field(default_factory=list)
    setup_python: list[str] = field(default_factory=list)
    setup_node: list[str] = field(default_factory=list)
    setup_go: list[str] = field(default_factory=list)
    eas: list[str] = field(default_factory=list)

    @property
    def action_count(self) -> int:
        return len(self.step_actions) + len(self.reusable)

    @property
    def image_count(self) -> int:
        return len(self.docker_actions) + len(self.job_containers) + len(self.services) + len(self.dockerfile_bases)


@dataclass
class Context:
    errors: list[str] = field(default_factory=list)
    inventory: Inventory = field(default_factory=Inventory)
    checked_mappings: set[int] = field(default_factory=set)


def loc(path: Path, node: Any) -> str:
    mark = getattr(node, "start_mark", None)
    return str(path) if mark is None else f"{path}:{mark.line + 1}:{mark.column + 1}"


def load_yaml(errors: list[str]):
    try:
        import yaml  # type: ignore
    except Exception as exc:
        errors.append(f"semantic YAML parser unavailable: {type(exc).__name__}: {exc}")
        return None
    if getattr(yaml, "__version__", None) != YAML_VERSION:
        errors.append(f"semantic YAML parser version mismatch: expected {YAML_PACKAGE} {YAML_VERSION}, got {getattr(yaml, '__version__', None)!r}")
        return None
    return yaml


def verify_parser_bootstrap(root: Path, errors: list[str]) -> None:
    path = root / ".github/scripts/requirements-supply-chain.txt"
    try:
        lines = [x.strip() for x in path.read_text(encoding="utf-8").splitlines() if x.strip() and not x.lstrip().startswith("#")]
    except OSError as exc:
        errors.append(f"{path}: parser bootstrap requirements unavailable: {exc}")
        return
    if lines != [YAML_REQUIREMENT]:
        errors.append(f"{path}: parser bootstrap must contain exactly the pinned hashed requirement {YAML_REQUIREMENT!r}")


def load_hermetic_helper(root: Path, errors: list[str]):
    path = root / "backend/hermetic_python.py"
    if not path.is_file():
        errors.append(f"{path}: canonical hermetic Python bootstrap helper is missing")
        return None
    try:
        spec = importlib.util.spec_from_file_location("financeflow_hermetic_python", path)
        if spec is None or spec.loader is None:
            raise ImportError("cannot create import spec")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    except Exception as exc:
        errors.append(f"{path}: canonical hermetic Python bootstrap helper cannot be imported: {type(exc).__name__}: {exc}")
        return None


def verify_python_locks(root: Path, errors: list[str]) -> None:
    helper = load_hermetic_helper(root, errors)
    if helper is None:
        return
    pip_lock = root / "backend/requirements-pip-bootstrap.lock"
    backend_lock = root / "backend/requirements.lock"
    backend_direct = root / "backend/requirements.txt"
    audit_lock = root / ".github/scripts/requirements-pip-audit.lock"
    parser_lock = root / ".github/scripts/requirements-supply-chain.txt"
    try:
        pip_rows = helper.parse_lock(pip_lock)
        backend_rows = helper.parse_lock(backend_lock)
        audit_rows = helper.parse_lock(audit_lock)
        parser_rows = helper.parse_lock(parser_lock)
        helper.verify_direct_coverage(backend_direct, backend_lock)
    except Exception as exc:
        errors.append(f"hermetic Python lock validation failed: {type(exc).__name__}: {exc}")
        return
    if set(pip_rows) != {"pip"} or pip_rows["pip"].version != PIP_VERSION:
        errors.append(f"{pip_lock}: must contain only pip=={PIP_VERSION} with sha256")
    if len(backend_rows) < 1:
        errors.append(f"{backend_lock}: backend lock is empty")
    for key, expected in (("pip", PIP_VERSION), ("pip-audit", PIP_AUDIT_VERSION)):
        if key not in audit_rows or audit_rows[key].version != expected:
            errors.append(f"{audit_lock}: must contain {key}=={expected} with sha256")
    if set(parser_rows) != {"pyyaml"} or parser_rows["pyyaml"].version != YAML_VERSION:
        errors.append(f"{parser_lock}: must contain only PyYAML=={YAML_VERSION} with sha256")


def verify_npm_tool_lock(root: Path, errors: list[str]) -> None:
    pkg_path = root / ".github/npm-tools/package.json"
    lock_path = root / ".github/npm-tools/package-lock.json"
    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"release-tool npm lock unavailable/invalid: {type(exc).__name__}: {exc}")
        return
    expected = {"eas-cli": EAS_VERSION, "expo-doctor": EXPO_DOCTOR_VERSION}
    if pkg.get("devDependencies") != expected:
        errors.append(f"{pkg_path}: devDependencies must be exactly {expected!r}")
    if lock.get("lockfileVersion") != 3:
        errors.append(f"{lock_path}: lockfileVersion must be 3")
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not packages:
        errors.append(f"{lock_path}: packages inventory missing")
        return
    root_pkg = packages.get("")
    if not isinstance(root_pkg, dict) or root_pkg.get("devDependencies") != expected:
        errors.append(f"{lock_path}: root devDependencies do not match approved release tools")
    checked = 0
    for name, meta in packages.items():
        if name == "":
            continue
        if not isinstance(meta, dict):
            errors.append(f"{lock_path}: package entry {name!r} must be a mapping")
            continue
        if meta.get("link") is True:
            errors.append(f"{lock_path}: linked package {name!r} is not accepted in release-tool closure")
            continue
        version = meta.get("version")
        resolved = meta.get("resolved")
        integrity = meta.get("integrity")
        if not isinstance(version, str) or not version:
            errors.append(f"{lock_path}: package {name!r} has no exact version")
        if not isinstance(resolved, str) or not resolved.startswith("https://registry.npmjs.org/"):
            errors.append(f"{lock_path}: package {name!r} has non-registry or missing resolved URL")
        if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
            errors.append(f"{lock_path}: package {name!r} has no sha512 integrity")
        checked += 1
    if checked == 0:
        errors.append(f"{lock_path}: no external release-tool packages were checked")


def mapping(path: Path, node: Any, ctx: Context, where: str) -> dict[str, Any]:
    try:
        from yaml.nodes import MappingNode, ScalarNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return {}
    if not isinstance(node, MappingNode):
        ctx.errors.append(f"{loc(path, node)}: {where} must be a mapping")
        return {}
    result: dict[str, Any] = {}
    first = id(node) not in ctx.checked_mappings
    ctx.checked_mappings.add(id(node))
    for key_node, value_node in node.value:
        if not isinstance(key_node, ScalarNode):
            if first:
                ctx.errors.append(f"{loc(path, key_node)}: {where} contains a non-scalar key; discovery is ambiguous")
            continue
        key = key_node.value
        if key_node.tag == MERGE_TAG or key == "<<":
            if first:
                ctx.errors.append(f"{loc(path, key_node)}: YAML merge keys are not accepted in security-critical workflow discovery")
            continue
        if key in result:
            if first:
                ctx.errors.append(f"{loc(path, key_node)}: duplicate YAML key {key!r} in {where} is ambiguous")
            continue
        result[key] = value_node
    return result


def literal(path: Path, node: Any, ctx: Context, where: str, *, dynamic_ok: bool = False) -> str | None:
    try:
        from yaml.nodes import ScalarNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return None
    if not isinstance(node, ScalarNode) or node.tag != STR_TAG:
        ctx.errors.append(f"{loc(path, node)}: {where} must be a literal YAML string, got {getattr(node, 'tag', type(node).__name__)!r}")
        return None
    value = node.value
    if not dynamic_ok and "${{" in value:
        ctx.errors.append(f"{loc(path, node)}: {where} uses a dynamic expression that cannot be proven immutable")
        return None
    return value


def line_comment(line: str) -> str | None:
    single = double = escaped = False
    for i, ch in enumerate(line):
        if double:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                double = False
        elif single:
            if ch == "'":
                single = False
        elif ch == '"':
            double = True
        elif ch == "'":
            single = True
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            text = line[i + 1:].strip()
            return text or None
    return None


def require_comment(path: Path, lines: list[str], node: Any, ctx: Context) -> None:
    mark = getattr(node, "end_mark", None)
    if mark is None or mark.line >= len(lines) or line_comment(lines[mark.line]) is None:
        ctx.errors.append(f"{loc(path, node)}: immutable external pin must keep a human-readable version comment")


def image(path: Path, node: Any, ctx: Context, where: str, bucket: list[str]) -> None:
    value = literal(path, node, ctx, where)
    if value is None:
        return
    bucket.append(f"{path}:{value}")
    if not DIGEST_IMAGE.fullmatch(value):
        ctx.errors.append(f"{loc(path, node)}: {where} must be digest-pinned with @sha256:<64 hex>: {value}")


def uses(path: Path, lines: list[str], node: Any, ctx: Context, where: str, *, reusable: bool) -> str | None:
    value = literal(path, node, ctx, where)
    if value is None:
        return None
    if value.startswith("./"):
        return value
    if value.startswith("docker://"):
        if reusable:
            ctx.errors.append(f"{loc(path, node)}: reusable workflow uses cannot use docker://")
            return value
        ref = value.removeprefix("docker://")
        ctx.inventory.docker_actions.append(f"{path}:{ref}")
        if not DIGEST_IMAGE.fullmatch(ref):
            ctx.errors.append(f"{loc(path, node)}: docker action image must be digest-pinned: {ref}")
        return value
    if "@" not in value:
        ctx.errors.append(f"{loc(path, node)}: external uses value has no ref: {value}")
        return value
    target, ref = value.rsplit("@", 1)
    if not target or not FULL_SHA.fullmatch(ref):
        ctx.errors.append(f"{loc(path, node)}: external uses must use a full 40-char commit SHA: {value}")
        return value
    require_comment(path, lines, node, ctx)
    bucket = ctx.inventory.reusable if reusable else ctx.inventory.step_actions
    bucket.append(f"{path}:{value}")
    return value


def with_value(path: Path, step: dict[str, Any], ctx: Context, key: str, where: str) -> str | None:
    node = step.get("with")
    if node is None:
        ctx.errors.append(f"{where}: missing with mapping")
        return None
    data = mapping(path, node, ctx, f"{where} with")
    if key not in data:
        ctx.errors.append(f"{where}: missing with.{key}")
        return None
    return literal(path, data[key], ctx, f"{where} with.{key}")


def verify_runtime_selector(path: Path, step: dict[str, Any], uses_value: str | None, ctx: Context, where: str) -> None:
    if not uses_value:
        return
    if uses_value.startswith("actions/setup-python@"):
        value = with_value(path, step, ctx, "python-version", where)
        if value != PYTHON_VERSION:
            ctx.errors.append(f"{where}: setup-python must use exact Python {PYTHON_VERSION}, got {value!r}")
        else:
            ctx.inventory.setup_python.append(f"{path}:{value}")
    elif uses_value.startswith("actions/setup-node@"):
        value = with_value(path, step, ctx, "node-version", where)
        if value != NODE_VERSION:
            ctx.errors.append(f"{where}: setup-node must use exact Node {NODE_VERSION}, got {value!r}")
        else:
            ctx.inventory.setup_node.append(f"{path}:{value}")
    elif uses_value.startswith("actions/setup-go@"):
        value = with_value(path, step, ctx, "go-version", where)
        if value != GO_VERSION:
            ctx.errors.append(f"{where}: setup-go must use exact Go {GO_VERSION}, got {value!r}")
        else:
            ctx.inventory.setup_go.append(f"{path}:{value}")
    elif uses_value.startswith("expo/expo-github-action@"):
        value = with_value(path, step, ctx, "eas-version", where)
        if value != EAS_VERSION:
            ctx.errors.append(f"{where}: eas-version must be exact {EAS_VERSION}, got {value!r}")
        else:
            ctx.inventory.eas.append(f"{path}:eas@{value}")


def logical_shell_lines(script: str) -> list[str]:
    result: list[str] = []
    current = ""
    for raw in script.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        current = current + " " + stripped if current else stripped
        if current.endswith("\\"):
            current = current[:-1].rstrip()
            continue
        result.append(current)
        current = ""
    if current:
        result.append(current)
    return result


def shell_commands(line: str) -> list[list[str]]:
    lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = "#"
    tokens = list(lexer)
    commands: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token and all(ch in ";&|" for ch in token):
            if current:
                commands.append(current)
                current = []
            continue
        current.append(token)
    if current:
        commands.append(current)
    return commands


def strip_prefix_tokens(tokens: list[str]) -> list[str]:
    out = list(tokens)
    while out and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", out[0]):
        out.pop(0)
    if out and out[0] in {"sudo", "env"}:
        out.pop(0)
        while out and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", out[0]):
            out.pop(0)
    return out


def is_hermetic_helper(tokens: list[str]) -> bool:
    if len(tokens) < 3 or tokens[0] not in {"python", "python3"}:
        return False
    if tokens[1] not in {"backend/hermetic_python.py", "hermetic_python.py"}:
        return False
    required = {
        "--pip-lock", "--requirements-lock", "--expected-python",
        "--expected-initial-pip", "--expected-pip", "--label"
    }
    return required.issubset(tokens) and PYTHON_VERSION in tokens and PIP_VERSION in tokens


def scan_script(path: Path, script: str, ctx: Context, where: str, source: str) -> None:
    for line in logical_shell_lines(script):
        try:
            commands = shell_commands(line)
        except ValueError as exc:
            ctx.errors.append(f"{source}: cannot parse shell command for supply-chain policy: {exc}")
            continue
        for raw_tokens in commands:
            tokens = strip_prefix_tokens(raw_tokens)
            if not tokens:
                continue
            exe = tokens[0]
            if is_hermetic_helper(tokens):
                ctx.inventory.python_bootstraps.append(f"{path}:{where}:{' '.join(tokens)}")
                continue
            lower = [token.lower() for token in tokens]
            python_pip = exe in {"python", "python3"} and len(lower) >= 3 and lower[1] == "-m" and lower[2] == "pip"
            bare_pip = exe in {"pip", "pip3"}
            if python_pip or bare_pip:
                offset = 3 if python_pip else 1
                subcommand = lower[offset] if len(lower) > offset else ""
                if subcommand in {"check", "--version", "-v"}:
                    continue
                ctx.errors.append(f"{source}: direct Python package/tool bootstrap is forbidden; use canonical hermetic helper: {' '.join(tokens)}")
                continue
            if exe in {"pipx", "uv", "poetry", "pip-compile", "pip-sync"} or (exe in {"python", "python3"} and len(lower) >= 3 and lower[1] == "-m" and lower[2] in {"ensurepip", "pipx"}):
                ctx.errors.append(f"{source}: direct Python package/tool bootstrap is forbidden; use canonical hermetic helper: {' '.join(tokens)}")
                continue
            if exe == "npx":
                ctx.errors.append(f"{source}: npx download/execute is forbidden; execute a lockfile-installed local binary: {' '.join(tokens)}")
                continue
            if exe == "npm":
                sub = lower[1] if len(lower) > 1 else ""
                if sub == "ci":
                    if "--ignore-scripts" not in tokens:
                        ctx.errors.append(f"{source}: npm ci must use --ignore-scripts in release/relevant workflows")
                    if any(".github/npm-tools" in token for token in tokens) and "--legacy-peer-deps" not in tokens:
                        ctx.errors.append(f"{source}: release-tool npm ci must use the checked-in peer policy --legacy-peer-deps")
                    ctx.inventory.npm_ci.append(f"{path}:{where}:{' '.join(tokens)}")
                elif sub in {"install", "i", "add", "update", "upgrade"}:
                    ctx.errors.append(f"{source}: mutable npm dependency resolution is forbidden in release/relevant workflows: {' '.join(tokens)}")
                continue
            if exe in {"yarn", "pnpm", "bun"} and any(x in lower[1:3] for x in {"install", "add", "update", "upgrade"}):
                ctx.errors.append(f"{source}: mutable package-manager install is forbidden: {' '.join(tokens)}")
                continue
            if exe in {"curl", "wget"}:
                urls = [t for t in tokens[1:] if t.startswith(("http://", "https://"))]
                if not urls or any(not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)", u) for u in urls):
                    ctx.errors.append(f"{source}: external/dynamic curl/wget input is not allowed in release evidence: {' '.join(tokens)}")
                else:
                    ctx.inventory.loopback_downloads.append(f"{path}:{where}:{' '.join(tokens)}")
                continue
            if exe in {"apt", "apt-get", "apk", "dnf", "yum"} and any(x in lower[1:3] for x in {"install", "update", "upgrade", "add"}):
                ctx.errors.append(f"{source}: mutable OS package bootstrap is forbidden in release/relevant workflow run steps: {' '.join(tokens)}")


def scan_run(path: Path, node: Any, ctx: Context, where: str) -> None:
    script = literal(path, node, ctx, where, dynamic_ok=True)
    if script is not None:
        scan_script(path, script, ctx, where, loc(path, node))


def inspect_workflow(path: Path, ctx: Context, yaml: Any) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        ctx.errors.append(f"{path}: workflow cannot be read as UTF-8: {exc}")
        return
    lines = text.splitlines()
    try:
        root_node = yaml.compose(text, Loader=yaml.SafeLoader)
    except Exception as exc:
        ctx.errors.append(f"{path}: workflow YAML parse failed closed: {type(exc).__name__}: {exc}")
        return
    if root_node is None:
        ctx.errors.append(f"{path}: workflow YAML document is empty")
        return
    root = mapping(path, root_node, ctx, "workflow root")
    jobs_node = root.get("jobs")
    if jobs_node is None:
        ctx.errors.append(f"{path}: workflow has no jobs mapping; executable inventory is ambiguous")
        return
    jobs = mapping(path, jobs_node, ctx, "jobs")
    try:
        from yaml.nodes import MappingNode, ScalarNode, SequenceNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return
    for job_name, job_node in jobs.items():
        job = mapping(path, job_node, ctx, f"job {job_name!r}")
        if "uses" in job:
            uses(path, lines, job["uses"], ctx, f"job {job_name!r} reusable workflow uses", reusable=True)
        if "container" in job:
            node = job["container"]
            if isinstance(node, ScalarNode):
                image(path, node, ctx, f"job {job_name!r} container image", ctx.inventory.job_containers)
            elif isinstance(node, MappingNode):
                data = mapping(path, node, ctx, f"job {job_name!r} container")
                if "image" not in data:
                    ctx.errors.append(f"{loc(path, node)}: job {job_name!r} container mapping has no image")
                else:
                    image(path, data["image"], ctx, f"job {job_name!r} container image", ctx.inventory.job_containers)
            else:
                ctx.errors.append(f"{loc(path, node)}: job {job_name!r} container must be a literal image string or mapping")
        if "services" in job:
            for service_name, service_node in mapping(path, job["services"], ctx, f"job {job_name!r} services").items():
                data = mapping(path, service_node, ctx, f"job {job_name!r} service {service_name!r}")
                if "image" not in data:
                    ctx.errors.append(f"{loc(path, service_node)}: service {service_name!r} has no image")
                else:
                    image(path, data["image"], ctx, f"service {service_name!r} image", ctx.inventory.services)
        if "steps" in job:
            steps_node = job["steps"]
            if not isinstance(steps_node, SequenceNode):
                ctx.errors.append(f"{loc(path, steps_node)}: job {job_name!r} steps must be a sequence")
            else:
                for index, step_node in enumerate(steps_node.value):
                    step = mapping(path, step_node, ctx, f"job {job_name!r} step {index}")
                    where = f"job {job_name!r} step {index}"
                    if "uses" in step:
                        value = uses(path, lines, step["uses"], ctx, f"{where} uses", reusable=False)
                        verify_runtime_selector(path, step, value, ctx, where)
                    if "run" in step:
                        scan_run(path, step["run"], ctx, f"{where} run")


def inspect_dockerfiles(root: Path, ctx: Context) -> None:
    for path in sorted(p for p in root.rglob("Dockerfile*") if ".git" not in p.parts and p.is_file()):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            ctx.errors.append(f"{path}: Dockerfile cannot be read as UTF-8: {exc}")
            continue
        lines = text.splitlines()
        for number, line in enumerate(lines, 1):
            match = FROM_RE.match(line)
            if not match:
                continue
            ref = match.group(1)
            if ref.lower() == "scratch":
                continue
            ctx.inventory.dockerfile_bases.append(f"{path}:{ref}")
            if not DIGEST_IMAGE.fullmatch(ref):
                ctx.errors.append(f"{path}:{number}: Dockerfile base image must be digest-pinned: {ref}")
        run_lines: list[tuple[int, str]] = []
        current = ""
        start = 0
        for number, raw in enumerate(lines, 1):
            if current:
                current += " " + raw.strip()
            elif re.match(r"^\s*RUN\s+", raw, re.I):
                current = re.sub(r"^\s*RUN\s+", "", raw, flags=re.I).strip()
                start = number
            else:
                continue
            if current.endswith("\\"):
                current = current[:-1].rstrip()
                continue
            run_lines.append((start, current))
            current = ""
        for number, script in run_lines:
            scan_script(path, script, ctx, f"Dockerfile RUN {number}", f"{path}:{number}")


def inspect(root: Path) -> Context:
    ctx = Context()
    verify_parser_bootstrap(root, ctx.errors)
    verify_python_locks(root, ctx.errors)
    verify_npm_tool_lock(root, ctx.errors)
    yaml = load_yaml(ctx.errors)
    workflows = root / ".github/workflows"
    paths = sorted({*workflows.glob("*.yml"), *workflows.glob("*.yaml")})
    ctx.inventory.workflows = [str(p) for p in paths]
    if not paths:
        ctx.errors.append("no workflow files were discovered; workflow inventory may be broken")
    if yaml is not None:
        for path in paths:
            inspect_workflow(path, ctx, yaml)
    inspect_dockerfiles(root, ctx)
    if ctx.inventory.action_count == 0:
        ctx.errors.append("no external actions/reusable workflows were discovered; workflow inventory may be broken")
    if ctx.inventory.image_count == 0:
        ctx.errors.append("no Docker/workflow images were discovered; image inventory may be broken")
    if not ctx.inventory.python_bootstraps:
        ctx.errors.append("no approved hermetic Python bootstrap invocation was discovered")
    return ctx


def print_inventory(ctx: Context) -> None:
    i = ctx.inventory
    print(f"SUPPLY_CHAIN_YAML_PARSER={YAML_PACKAGE} {YAML_VERSION}")
    print(f"SUPPLY_CHAIN_WORKFLOWS={len(i.workflows)}")
    print(f"SUPPLY_CHAIN_EXTERNAL_STEP_ACTIONS={len(i.step_actions)}")
    print(f"SUPPLY_CHAIN_EXTERNAL_REUSABLE_WORKFLOWS={len(i.reusable)}")
    print(f"SUPPLY_CHAIN_DOCKER_ACTIONS={len(i.docker_actions)}")
    print(f"SUPPLY_CHAIN_JOB_CONTAINERS={len(i.job_containers)}")
    print(f"SUPPLY_CHAIN_SERVICE_IMAGES={len(i.services)}")
    print(f"SUPPLY_CHAIN_DOCKERFILE_BASES={len(i.dockerfile_bases)}")
    print(f"SUPPLY_CHAIN_HERMETIC_PYTHON_BOOTSTRAPS={len(i.python_bootstraps)}")
    print(f"SUPPLY_CHAIN_NPM_CI={len(i.npm_ci)}")
    print(f"SUPPLY_CHAIN_LOOPBACK_DOWNLOADS={len(i.loopback_downloads)}")
    print(f"SUPPLY_CHAIN_SETUP_PYTHON={len(i.setup_python)}")
    print(f"SUPPLY_CHAIN_SETUP_NODE={len(i.setup_node)}")
    print(f"SUPPLY_CHAIN_SETUP_GO={len(i.setup_go)}")
    for label, values in (("WORKFLOW", i.workflows), ("STEP_ACTION", i.step_actions), ("REUSABLE_WORKFLOW", i.reusable), ("DOCKER_ACTION", i.docker_actions), ("JOB_CONTAINER", i.job_containers), ("SERVICE_IMAGE", i.services), ("DOCKERFILE_BASE", i.dockerfile_bases), ("PYTHON_BOOTSTRAP", i.python_bootstraps), ("NPM_CI", i.npm_ci), ("LOOPBACK_DOWNLOAD", i.loopback_downloads)):
        for value in values:
            print(f"SUPPLY_CHAIN_INVENTORY_{label}={value}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    root = parser.parse_args().root.resolve()
    ctx = inspect(root)
    print_inventory(ctx)
    if ctx.errors:
        print("SUPPLY_CHAIN_POLICY=fail")
        for error in ctx.errors:
            print(f"- {error}")
        return 1
    print("SUPPLY_CHAIN_POLICY=pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
