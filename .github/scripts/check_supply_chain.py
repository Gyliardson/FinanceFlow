#!/usr/bin/env python3
"""Fail closed when workflow-controlled executable supply-chain inputs are mutable."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from pathlib import Path
import re
import sys
from typing import Any

YAML_PACKAGE = "PyYAML"
YAML_VERSION = "6.0.3"
YAML_REQUIREMENT = (
    "PyYAML==6.0.3 "
    "--hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc"
)
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST_IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
EXTERNAL_USES = re.compile(r"^[^/@\s]+/[^/@\s]+(?:/[^@\s]+)*$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
FROM_RE = re.compile(r"^\s*FROM(?:\s+--platform=[^\s]+)?\s+([^\s]+)", re.I)
EXPO_RE = re.compile(r"\bexpo-doctor@(\d+\.\d+\.\d+)\b")
PIP_AUDIT_RE = re.compile(r"\bpip-audit==(\d+\.\d+\.\d+)\b")
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
    expo: list[str] = field(default_factory=list)
    pip_audit: list[str] = field(default_factory=list)
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


def verify_bootstrap(root: Path, errors: list[str]) -> None:
    path = root / ".github/scripts/requirements-supply-chain.txt"
    try:
        lines = [x.strip() for x in path.read_text(encoding="utf-8").splitlines() if x.strip() and not x.lstrip().startswith("#")]
    except OSError as exc:
        errors.append(f"{path}: parser bootstrap requirements unavailable: {exc}")
        return
    if lines != [YAML_REQUIREMENT]:
        errors.append(f"{path}: parser bootstrap must contain exactly the pinned hashed requirement {YAML_REQUIREMENT!r}")


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
    i = 0
    while i < len(line):
        ch = line[i]
        if double:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                double = False
        elif single:
            if ch == "'":
                if i + 1 < len(line) and line[i + 1] == "'":
                    i += 1
                else:
                    single = False
        elif ch == '"':
            double = True
        elif ch == "'":
            single = True
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            text = line[i + 1:].strip()
            return text or None
        i += 1
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


def uses(path: Path, lines: list[str], node: Any, ctx: Context, where: str, *, reusable: bool) -> None:
    value = literal(path, node, ctx, where)
    if value is None:
        return
    if value.startswith("./"):
        return
    if value.startswith("docker://"):
        if reusable:
            ctx.errors.append(f"{loc(path, node)}: reusable workflow uses cannot use docker://")
            return
        ref = value.removeprefix("docker://")
        ctx.inventory.docker_actions.append(f"{path}:{ref}")
        if not DIGEST_IMAGE.fullmatch(ref):
            ctx.errors.append(f"{loc(path, node)}: docker action image must be digest-pinned: {ref}")
        return
    if "@" not in value:
        ctx.errors.append(f"{loc(path, node)}: external uses has no ref: {value}")
        return
    target, ref = value.rsplit("@", 1)
    if not EXTERNAL_USES.fullmatch(target):
        ctx.errors.append(f"{loc(path, node)}: external uses target is not a literal owner/repository path: {target!r}")
        return
    (ctx.inventory.reusable if reusable else ctx.inventory.step_actions).append(f"{path}:{value}")
    if not FULL_SHA.fullmatch(ref):
        ctx.errors.append(f"{loc(path, node)}: {target} must be pinned to a full 40-char commit SHA, got {ref!r}")
    else:
        require_comment(path, lines, node, ctx)


def scan_eas(path: Path, node: Any, ctx: Context, active: set[int] | None = None, visited: set[int] | None = None) -> None:
    try:
        from yaml.nodes import MappingNode, SequenceNode, ScalarNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return
    active = set() if active is None else active
    visited = set() if visited is None else visited
    nid = id(node)
    if nid in active:
        ctx.errors.append(f"{loc(path, node)}: recursive YAML alias cycle cannot be analyzed safely")
        return
    if nid in visited:
        return
    active.add(nid)
    visited.add(nid)
    try:
        if isinstance(node, MappingNode):
            for key, child in mapping(path, node, ctx, "workflow mapping").items():
                if key == "eas-version":
                    value = literal(path, child, ctx, "eas-version")
                    if value is not None:
                        ctx.inventory.eas.append(f"{path}:{value}")
                        if not SEMVER.fullmatch(value):
                            ctx.errors.append(f"{loc(path, child)}: eas-version must be an exact semver, got {value!r}")
                scan_eas(path, child, ctx, active, visited)
        elif isinstance(node, SequenceNode):
            for child in node.value:
                scan_eas(path, child, ctx, active, visited)
        elif not isinstance(node, ScalarNode):
            ctx.errors.append(f"{loc(path, node)}: unsupported YAML node type {type(node).__name__}")
    finally:
        active.remove(nid)


def scan_tool_lines(path: Path, text: str, ctx: Context) -> None:
    for number, line in enumerate(text.splitlines(), 1):
        if "expo-doctor" in line:
            match = EXPO_RE.search(line)
            if match:
                ctx.inventory.expo.append(f"{path}:expo-doctor@{match.group(1)}")
            else:
                ctx.errors.append(f"{path}:{number}: expo-doctor execution must use an exact package version")
        if "pip install" in line and "pip-audit" in line:
            match = PIP_AUDIT_RE.search(line)
            if match:
                ctx.inventory.pip_audit.append(f"{path}:pip-audit=={match.group(1)}")
            else:
                ctx.errors.append(f"{path}:{number}: pip-audit installation must use an exact package version")


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
        scan_eas(path, root_node, ctx)
        scan_tool_lines(path, text, ctx)
        return
    jobs = mapping(path, jobs_node, ctx, "jobs")
    if not jobs:
        ctx.errors.append(f"{loc(path, jobs_node)}: jobs mapping is empty")
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
                    if "uses" in step:
                        uses(path, lines, step["uses"], ctx, f"job {job_name!r} step {index} uses", reusable=False)
    scan_eas(path, root_node, ctx)
    scan_tool_lines(path, text, ctx)


def inspect_dockerfiles(root: Path, ctx: Context) -> None:
    for path in sorted(p for p in root.rglob("Dockerfile*") if ".git" not in p.parts and p.is_file()):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as exc:
            ctx.errors.append(f"{path}: Dockerfile cannot be read as UTF-8: {exc}")
            continue
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


def inspect(root: Path) -> Context:
    ctx = Context()
    verify_bootstrap(root, ctx.errors)
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
    print(f"SUPPLY_CHAIN_EXPO_DOCTOR_PINS={len(i.expo)}")
    print(f"SUPPLY_CHAIN_PIP_AUDIT_PINS={len(i.pip_audit)}")
    print(f"SUPPLY_CHAIN_EAS_PINS={len(i.eas)}")
    for label, values in (("WORKFLOW", i.workflows), ("STEP_ACTION", i.step_actions), ("REUSABLE_WORKFLOW", i.reusable), ("DOCKER_ACTION", i.docker_actions), ("JOB_CONTAINER", i.job_containers), ("SERVICE_IMAGE", i.services), ("DOCKERFILE_BASE", i.dockerfile_bases), ("EXPO_DOCTOR", i.expo), ("PIP_AUDIT", i.pip_audit), ("EAS", i.eas)):
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
    sys.exit(main())
