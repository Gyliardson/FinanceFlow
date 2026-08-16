#!/usr/bin/env python3
"""Fail CI when repository-controlled executable supply-chain inputs are mutable."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

FULL_SHA = re.compile(r'^[0-9a-f]{40}$')
SHA256_IMAGE = re.compile(r'^.+@sha256:[0-9a-f]{64}$')
USES_RE = re.compile(r'^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$')
EAS_RE = re.compile(r'^\s*eas-version:\s*([^\s#]+)')
IMAGE_RE = re.compile(r'^\s*image:\s*([^\s#]+)')
FROM_RE = re.compile(r'^\s*FROM(?:\s+--platform=[^\s]+)?\s+([^\s]+)', re.IGNORECASE)
EXPO_DOCTOR_PIN_RE = re.compile(r'\bexpo-doctor@(\d+\.\d+\.\d+)\b')
PIP_AUDIT_PIN_RE = re.compile(r'\bpip-audit==(\d+\.\d+\.\d+)\b')


def inspect(root: Path) -> list[str]:
    errors: list[str] = []
    workflows = root / '.github' / 'workflows'
    workflow_paths = sorted({*workflows.glob('*.yml'), *workflows.glob('*.yaml')})
    checked_actions = 0
    checked_images = 0

    for path in workflow_paths:
        for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            match = USES_RE.match(line)
            if match:
                uses_ref, version_comment = match.groups()
                if uses_ref.startswith('./'):
                    continue
                if uses_ref.startswith('docker://'):
                    docker_ref = uses_ref.removeprefix('docker://')
                    checked_images += 1
                    if not SHA256_IMAGE.fullmatch(docker_ref):
                        errors.append(
                            f'{path}:{line_number}: docker action image must be digest-pinned: {docker_ref}'
                        )
                    continue
                if '@' not in uses_ref:
                    errors.append(f'{path}:{line_number}: external action has no ref: {uses_ref}')
                    continue
                action, ref = uses_ref.rsplit('@', 1)
                checked_actions += 1
                if not FULL_SHA.fullmatch(ref):
                    errors.append(
                        f'{path}:{line_number}: {action} must be pinned to a full 40-char commit SHA, got {ref!r}'
                    )
                if not version_comment:
                    errors.append(
                        f'{path}:{line_number}: immutable action pin must keep a human-readable version comment'
                    )

            eas_match = EAS_RE.match(line)
            if eas_match:
                value = eas_match.group(1).strip('"\'')
                if value.lower() == 'latest' or not re.fullmatch(r'\d+\.\d+\.\d+', value):
                    errors.append(
                        f'{path}:{line_number}: eas-version must be an exact semver, got {value!r}'
                    )

            image_match = IMAGE_RE.match(line)
            if image_match:
                image_ref = image_match.group(1).strip('"\'')
                checked_images += 1
                if not SHA256_IMAGE.fullmatch(image_ref):
                    errors.append(
                        f'{path}:{line_number}: workflow container/service image must be digest-pinned: {image_ref}'
                    )

            if 'expo-doctor' in line and not EXPO_DOCTOR_PIN_RE.search(line):
                errors.append(
                    f'{path}:{line_number}: expo-doctor execution must use an exact package version'
                )

            if 'pip install' in line and 'pip-audit' in line and not PIP_AUDIT_PIN_RE.search(line):
                errors.append(
                    f'{path}:{line_number}: pip-audit installation must use an exact package version'
                )

    dockerfiles = sorted(
        path for path in root.rglob('Dockerfile*')
        if '.git' not in path.parts and path.is_file()
    )
    for path in dockerfiles:
        for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            match = FROM_RE.match(line)
            if not match:
                continue
            image_ref = match.group(1)
            if image_ref.lower() == 'scratch':
                continue
            checked_images += 1
            if not SHA256_IMAGE.fullmatch(image_ref):
                errors.append(
                    f'{path}:{line_number}: Dockerfile base image must be digest-pinned: {image_ref}'
                )

    if not workflow_paths:
        errors.append('no workflow files were discovered; workflow inventory may be broken')
    if checked_actions == 0:
        errors.append('no external actions were discovered; workflow inventory may be broken')
    if checked_images == 0:
        errors.append('no Docker/workflow images were discovered; image inventory may be broken')

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('.'))
    args = parser.parse_args()
    root = args.root.resolve()
    errors = inspect(root)

    if errors:
        print('SUPPLY_CHAIN_POLICY=fail')
        for error in errors:
            print(f'- {error}')
        return 1

    print('SUPPLY_CHAIN_POLICY=pass')
    return 0


if __name__ == '__main__':
    sys.exit(main())
