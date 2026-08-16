#!/usr/bin/env python3
"""Fail CI when repository-controlled executable supply-chain inputs are mutable.

Workflow executable inputs are discovered from the YAML node graph, not from line shape.
Text inspection is retained only for the pre-existing human-readable pin-comment metadata
and Dockerfile syntax, whose semantics are line-oriented by their native formats.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from pathlib import Path
import re
import sys
from typing import Any

EXPECTED_YAML_PACKAGE = "PyYAML"
EXPECTED_YAML_VERSION = "6.0.3"
EXPECTED_YAML_REQUIREMENT = (
    "PyYAML==6.0.3 "
    "--hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc"
)

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256_IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
EXTERNAL_USES_TARGET = re.compile(r"^[^/@\s]+/[^/@\s]+(?:/[^@\s]+)*$")
EXACT_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
FROM_RE = re.compile(r"^\s*FROM(?:\s+--platform=[^\s]+)?\s+([^\s]+)", re.IGNORECASE)
EXPO_DOCTOR_PIN_RE = re.compile(r"\bexpo-doctor@(\d+\.\d+\.\d+)\b")
PIP_AUDIT_PIN_RE = re.compile(r"\bpip-audit==(\d+\.\d+\.\d+)\b")
YAML_STR_TAG = "tag:yaml.org,2002:str"
YAML_MERGE_TAG = "tag:yaml.org,2002:merge"


@dataclass
class Inventory:
    workflows: list[str] = field(default_factory=list)
    external_step_actions: list[str] = field(default_factory=list)
    external_reusable_workflows: list[str] = field(default_factory=list)
    docker_actions: list[str] = field(default_factory=list)
    job_containers: list[str] = field(default_factory=list)
    service_images: list[str] = field(default_factory=list)
    dockerfile_bases: list[str] = field(default_factory=list)
    expo_doctor_pins: list[str] = field(default_factory=list)
    pip_audit_pins: list[str] = field(default_factory=list)
    eas_pins: list[str] = field(default_factory=list)

    @property
    def action_count(self) -> int:
        return len(self.external_step_actions) + len(self.external_reusable_workflows)

    @property
    def image_count(self) -> int:
        return (
            len(self.docker_actions)
            + len(self.job_containers)
            + len(self.service_images)
            + len(self.dockerfile_bases)
        )


@dataclass
class Context:
    errors: list[str] = field(default_factory=list)
    inventory: Inventory = field(default_factory=Inventory)
    checked_mappings: set[int] = field(default_factory=set)


def location(path: Path, node: Any) -> str:
    mark = getattr(node, "start_mark", None)
    if mark is None:
        return str(path)
    return f"{path}:{mark.line + 1}:{mark.column + 1}"


def load_yaml_module(errors: list[str]):
    try:
        import yaml  # type: ignore
    except Exception as exc:
        errors.append(f"semantic YAML parser unavailable: {type(exc).__name__}: {exc}")
        return None
    version = getattr(yaml, "__version__", None)
    if version != EXPECTED_YAML_VERSION:
        errors.append(
            f"semantic YAML parser version mismatch: expected {EXPECTED_YAML_PACKAGE} "
            f"{EXPECTED_YAML_VERSION}, got {version!r}"
        )
        return None
    return yaml


def verify_parser_bootstrap(root: Path, errors: list[str]) -> None:
    path = root / ".github" / "scripts" / "requirements-supply-chain.txt"
    try:
        lines = [
            line.strip()
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
    except OSError as exc:
        errors.append(f"{path}: parser bootstrap requirements unavailable: {exc}")
        return
    if lines != [EXPECTED_YAML_REQUIREMENT]:
        errors.append(
            f"{path}: parser bootstrap must contain exactly the pinned hashed requirement "
            f"{EXPECTED_YAML_REQUIREMENT!r}"
        )


def mapping_items(path: Path, node: Any, ctx: Context, where: str) -> dict[str, Any]:
    """Return mapping entries while failing closed on duplicate/merge/non-scalar keys."""
    try:
        from yaml.nodes import MappingNode, ScalarNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return {}

    if not isinstance(node, MappingNode):
        ctx.errors.append(f"{location(path, node)}: {where} must be a mapping")
        return {}

    result: dict[str, Any] = {}
    mapping_id = id(node)
    first_check = mapping_id not in ctx.checked_mappings
    if first_check:
        ctx.checked_mappings.add(mapping_id)

    for key_node, value_node in node.value:
        if not isinstance(key_node, ScalarNode):
            if first_check:
                ctx.errors.append(
                    f"{location(path, key_node)}: {where} contains a non-scalar key; discovery is ambiguous"
                )
            continue
        key = key_node.value
        if key_node.tag == YAML_MERGE_TAG or key == "<<":
            if first_check:
                ctx.errors.append(
                    f"{location(path, key_node)}: YAML merge keys are not accepted in security-critical workflow discovery"
                )
            continue
        if key in result:
            if first_check:
                ctx.errors.append(
                    f"{location(path, key_node)}: duplicate YAML key {key!r} in {where} is ambiguous"
                )
            continue
        result[key] = value_node
    return result


def scalar_string(path: Path, node: Any, ctx: Context, where: str) -> str | None:
    try:
        from yaml.nodes import ScalarNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return None
    if not isinstance(node, ScalarNode) or node.tag != YAML_STR_TAG:
        tag = getattr(node, "tag", type(node).__name__)
        ctx.errors.append(
            f"{location(path, node)}: {where} must be a literal YAML string, got {tag!r}"
        )
        return None
    value = node.value
    if "${{" in value:
        ctx.errors.append(
            f"{location(path, node)}: {where} uses a dynamic expression that cannot be proven immutable"
        )
        return None
    return value


def actual_comment_on_line(line: str) -> str | None:
    """Return a YAML comment outside quoted scalars on one source line."""
    single = False
    double = False
    escaped = False
    index = 0
    while index < len(line):
        char = line[index]
        if double:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                double = False
            index += 1
            continue
        if single:
            if char == "'":
                if index + 1 < len(line) and line[index + 1] == "'":
                    index += 2
                    continue
                single = False
            index += 1
            continue
        if char == '"':
            double = True
        elif char == "'":
            single = True
        elif char == "#" and (index == 0 or line[index - 1].isspace()):
            comment = line[index + 1 :].strip()
            return comment or None
        index += 1
    return None


def require_human_pin_metadata(
    path: Path,
    source_lines: list[str],
    node: Any,
    ctx: Context,
    where: str,
) -> None:
    mark = getattr(node, "end_mark", None)
    if mark is None or mark.line >= len(source_lines):
        ctx.errors.append(f"{location(path, node)}: {where} pin has no usable source location")
        return
    if actual_comment_on_line(source_lines[mark.line]) is None:
        ctx.errors.append(
            f"{location(path, node)}: immutable external pin must keep a human-readable version comment"
        )


def validate_image(path: Path, node: Any, ctx: Context, where: str, bucket: list[str]) -> None:
    value = scalar_string(path, node, ctx, where)
    if value is None:
        return
    bucket.append(f"{path}:{value}")
    if not SHA256_IMAGE.fullmatch(value):
        ctx.errors.append(
            f"{location(path, node)}: {where} must be digest-pinned with @sha256:<64 hex>: {value}"
        )


def validate_uses(
    path: Path,
    source_lines: list[str],
    node: Any,
    ctx: Context,
    where: str,
    *,
    reusable: bool,
) -> None:
    value = scalar_string(path, node, ctx, where)
    if value is None:
        return

    if value.startswith("./"):
        return

    if value.startswith("docker://"):
        if reusable:
            ctx.errors.append(
                f"{location(path, node)}: reusable workflow uses cannot use docker://"
            )
            return
        docker_ref = value.removeprefix("docker://")
        ctx.inventory.docker_actions.append(f"{path}:{docker_ref}")
        if not SHA256_IMAGE.fullmatch(docker_ref):
            ctx.errors.append(
                f"{location(path, node)}: docker action image must be digest-pinned: {docker_ref}"
            )
        return

    if "@" not in value:
        ctx.errors.append(f"{location(path, node)}: external uses has no ref: {value}")
        return
    target, ref = value.rsplit("@", 1)
    if not EXTERNAL_USES_TARGET.fullmatch(target):
        ctx.errors.append(
            f"{location(path, node)}: external uses target is not a literal owner/repository path: {target!r}"
        )
        return

    if reusable:
        ctx.inventory.external_reusable_workflows.append(f"{path}:{value}")
    else:
        ctx.inventory.external_step_actions.append(f"{path}:{value}")

    if not FULL_SHA.fullmatch(ref):
        ctx.errors.append(
            f"{location(path, node)}: {target} must be pinned to a full 40-char commit SHA, got {ref!r}"
        )
    else:
        require_human_pin_metadata(path, source_lines, node, ctx, where)


def scan_tooling(
    path: Path,
    node: Any,
    ctx: Context,
    *,
    active: set[int] | None = None,
    visited: set[int] | None = None,
) -> None:
    """Preserve existing exact tooling-pin policy while traversing YAML semantically."""
    try:
        from yaml.nodes import MappingNode, ScalarNode, SequenceNode  # type: ignore
    except Exception as exc:
        ctx.errors.append(f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}")
        return

    if active is None:
        active = set()
    if visited is None:
        visited = set()

    node_id = id(node)
    if node_id in active:
        ctx.errors.append(
            f"{location(path, node)}: recursive YAML alias cycle cannot be analyzed safely"
        )
        return
    if node_id in visited:
        return

    active.add(node_id)
    visited.add(node_id)
    try:
        if isinstance(node, MappingNode):
            items = mapping_items(path, node, ctx, "workflow mapping")
            for key, value_node in items.items():
                if key == "eas-version":
                    value = scalar_string(path, value_node, ctx, "eas-version")
                    if value is not None:
                        ctx.inventory.eas_pins.append(f"{path}:{value}")
                        if not EXACT_SEMVER.fullmatch(value):
                            ctx.errors.append(
                                f"{location(path, value_node)}: eas-version must be an exact semver, got {value!r}"
                            )
                if key == "run":
                    value = scalar_string(path, value_node, ctx, "run")
                    if value is not None:
                        for run_line in value.splitlines():
                            if "expo-doctor" in run_line:
                                match = EXPO_DOCTOR_PIN_RE.search(run_line)
                                if match is None:
                                    ctx.errors.append(
                                        f"{location(path, value_node)}: expo-doctor execution must use an exact package version"
                                    )
                                else:
                                    ctx.inventory.expo_doctor_pins.append(
                                        f"{path}:expo-doctor@{match.group(1)}"
                                    )
                            if "pip install" in run_line and "pip-audit" in run_line:
                                match = PIP_AUDIT_PIN_RE.search(run_line)
                                if match is None:
                                    ctx.errors.append(
                                        f"{location(path, value_node)}: pip-audit installation must use an exact package version"
                                    )
                                else:
                                    ctx.inventory.pip_audit_pins.append(
                                        f"{path}:pip-audit=={match.group(1)}"
                                    )
                scan_tooling(path, value_node, ctx, active=active, visited=visited)
        elif isinstance(node, SequenceNode):
            for child in node.value:
                scan_tooling(path, child, ctx, active=active, visited=visited)
        elif isinstance(node, ScalarNode):
            return
        else:
            ctx.errors.append(
                f"{location(path, node)}: unsupported YAML node type {type(node).__name__}"
            )
    finally:
        active.remove(node_id)


def inspect_workflow(path: Path, ctx: Context, yaml_module: Any) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        ctx.errors.append(f"{path}: workflow cannot be read as UTF-8: {exc}")
        return
    source_lines = text.splitlines()

    try:
        root_node = yaml_module.compose(text, Loader=yaml_module.SafeLoader)
    except Exception as exc:
        ctx.errors.append(
            f"{path}: workflow YAML parse failed closed: {type(exc).__name__}: {exc}"
        )
        return
    if root_node is None:
        ctx.errors.append(f"{path}: workflow YAML document is empty")
        return

    root = mapping_items(path, root_node, ctx, "workflow root")
    jobs_node = root.get("jobs")
    if jobs_node is None:
        ctx.errors.append(f"{path}: workflow has no jobs mapping; executable inventory is ambiguous")
        scan_tooling(path, root_node, ctx)
        return

    jobs = mapping_items(path, jobs_node, ctx, "jobs")
    if not jobs:
        ctx.errors.append(f"{location(path, jobs_node)}: jobs mapping is empty")

    for job_name, job_node in jobs.items():
        job = mapping_items(path, job_node, ctx, f"job {job_name!r}")

        job_uses = job.get("uses")
        if job_uses is not None:
            validate_uses(
                path,
                source_lines,
                job_uses,
                ctx,
                f"job {job_name!r} reusable workflow uses",
                reusable=True,
            )

        container_node = job.get("container")
        if container_node is not None:
            try:
                from yaml.nodes import MappingNode, ScalarNode  # type: ignore
            except Exception as exc:
                ctx.errors.append(
                    f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}"
                )
                continue
            if isinstance(container_node, ScalarNode):
                validate_image(
                    path,
                    container_node,
                    ctx,
                    f"job {job_name!r} container image",
                    ctx.inventory.job_containers,
                )
            elif isinstance(container_node, MappingNode):
                container = mapping_items(
                    path, container_node, ctx, f"job {job_name!r} container"
                )
                image_node = container.get("image")
                if image_node is None:
                    ctx.errors.append(
                        f"{location(path, container_node)}: job {job_name!r} container mapping has no image"
                    )
                else:
                    validate_image(
                        path,
                        image_node,
                        ctx,
                        f"job {job_name!r} container image",
                        ctx.inventory.job_containers,
                    )
            else:
                ctx.errors.append(
                    f"{location(path, container_node)}: job {job_name!r} container must be a literal image string or mapping"
                )

        services_node = job.get("services")
        if services_node is not None:
            services = mapping_items(path, services_node, ctx, f"job {job_name!r} services")
            for service_name, service_node in services.items():
                service = mapping_items(
                    path,
                    service_node,
                    ctx,
                    f"job {job_name!r} service {service_name!r}",
                )
                image_node = service.get("image")
                if image_node is None:
                    ctx.errors.append(
                        f"{location(path, service_node)}: service {service_name!r} has no image"
                    )
                else:
                    validate_image(
                        path,
                        image_node,
                        ctx,
                        f"service {service_name!r} image",
                        ctx.inventory.service_images,
                    )

        steps_node = job.get("steps")
        if steps_node is not None:
            try:
                from yaml.nodes import SequenceNode  # type: ignore
            except Exception as exc:
                ctx.errors.append(
                    f"semantic YAML parser node API unavailable: {type(exc).__name__}: {exc}"
                )
                continue
            if not isinstance(steps_node, SequenceNode):
                ctx.errors.append(
                    f"{location(path, steps_node)}: job {job_name!r} steps must be a sequence"
                )
            else:
                for index, step_node in enumerate(steps_node.value):
                    step = mapping_items(
                        path,
                        step_node,
                        ctx,
                        f"job {job_name!r} step {index}",
                    )
                    uses_node = step.get("uses")
                    if uses_node is not None:
                        validate_uses(
                            path,
                            source_lines,
                            uses_node,
                            ctx,
                            f"job {job_name!r} step {index} uses",
                            reusable=False,
                        )
                    run_node = step.get("run")
                    if run_node is not None:
                        scalar_string(
                            path,
                            run_node,
                            ctx,
                            f"job {job_name!r} step {index} run",
                        )

    scan_tooling(path, root_node, ctx)


def inspect_dockerfiles(root: Path, ctx: Context) -> None:
    dockerfiles = sorted(
        path
        for path in root.rglob("Dockerfile*")
        if ".git" not in path.parts and path.is_file()
    )
    for path in dockerfiles:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as exc:
            ctx.errors.append(f"{path}: Dockerfile cannot be read as UTF-8: {exc}")
            continue
        for line_number, line in enumerate(lines, 1):
            match = FROM_RE.match(line)
            if not match:
                continue
            image_ref = match.group(1)
            if image_ref.lower() == "scratch":
                continue
            ctx.inventory.dockerfile_bases.append(f"{path}:{image_ref}")
            if not SHA256_IMAGE.fullmatch(image_ref):
                ctx.errors.append(
                    f"{path}:{line_number}: Dockerfile base image must be digest-pinned: {image_ref}"
                )


def inspect(root: Path) -> Context:
    ctx = Context()
    verify_parser_bootstrap(root, ctx.errors)
    yaml_module = load_yaml_module(ctx.errors)

    workflows = root / ".github" / "workflows"
    workflow_paths = sorted({*workflows.glob("*.yml"), *workflows.glob("*.yaml")})
    ctx.inventory.workflows = [str(path) for path in workflow_paths]

    if not workflow_paths:
        ctx.errors.append("no workflow files were discovered; workflow inventory may be broken")

    if yaml_module is not None:
        for path in workflow_paths:
            inspect_workflow(path, ctx, yaml_module)

    inspect_dockerfiles(root, ctx)

    if ctx.inventory.action_count == 0:
        ctx.errors.append("no external actions/reusable workflows were discovered; workflow inventory may be broken")
    if ctx.inventory.image_count == 0:
        ctx.errors.append("no Docker/workflow images were discovered; image inventory may be broken")

    return ctx


def print_inventory(ctx: Context) -> None:
    inventory = ctx.inventory
    print(f"SUPPLY_CHAIN_YAML_PARSER={EXPECTED_YAML_PACKAGE} {EXPECTED_YAML_VERSION}")
    print(f"SUPPLY_CHAIN_WORKFLOWS={len(inventory.workflows)}")
    print(f"SUPPLY_CHAIN_EXTERNAL_STEP_ACTIONS={len(inventory.external_step_actions)}")
    print(f"SUPPLY_CHAIN_EXTERNAL_REUSABLE_WORKFLOWS={len(inventory.external_reusable_workflows)}")
    print(f"SUPPLY_CHAIN_DOCKER_ACTIONS={len(inventory.docker_actions)}")
    print(f"SUPPLY_CHAIN_JOB_CONTAINERS={len(inventory.job_containers)}")
    print(f"SUPPLY_CHAIN_SERVICE_IMAGES={len(inventory.service_images)}")
    print(f"SUPPLY_CHAIN_DOCKERFILE_BASES={len(inventory.dockerfile_bases)}")
    print(f"SUPPLY_CHAIN_EXPO_DOCTOR_PINS={len(inventory.expo_doctor_pins)}")
    print(f"SUPPLY_CHAIN_PIP_AUDIT_PINS={len(inventory.pip_audit_pins)}")
    print(f"SUPPLY_CHAIN_EAS_PINS={len(inventory.eas_pins)}")

    for label, values in (
        ("WORKFLOW", inventory.workflows),
        ("STEP_ACTION", inventory.external_step_actions),
        ("REUSABLE_WORKFLOW", inventory.external_reusable_workflows),
        ("DOCKER_ACTION", inventory.docker_actions),
        ("JOB_CONTAINER", inventory.job_containers),
        ("SERVICE_IMAGE", inventory.service_images),
        ("DOCKERFILE_BASE", inventory.dockerfile_bases),
        ("EXPO_DOCTOR", inventory.expo_doctor_pins),
        ("PIP_AUDIT", inventory.pip_audit_pins),
        ("EAS", inventory.eas_pins),
    ):
        for value in values:
            print(f"SUPPLY_CHAIN_INVENTORY_{label}={value}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args()
    root = args.root.resolve()

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
