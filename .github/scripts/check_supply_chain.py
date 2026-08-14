#!/usr/bin/env python3
"""Fail CI when workflows drift back to mutable action/tool references."""

from pathlib import Path
import re
import sys

WORKFLOWS = Path('.github/workflows')
FULL_SHA = re.compile(r'^[0-9a-f]{40}$')
USES_RE = re.compile(r'^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$')
EAS_RE = re.compile(r'^\s*eas-version:\s*([^\s#]+)')

errors: list[str] = []
checked = 0
workflow_paths = sorted({*WORKFLOWS.glob('*.yml'), *WORKFLOWS.glob('*.yaml')})

for path in workflow_paths:
    for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        match = USES_RE.match(line)
        if match:
            uses_ref, version_comment = match.groups()
            if uses_ref.startswith('./') or uses_ref.startswith('docker://'):
                continue
            if '@' not in uses_ref:
                errors.append(f'{path}:{line_number}: external action has no ref: {uses_ref}')
                continue
            action, ref = uses_ref.rsplit('@', 1)
            checked += 1
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

if not workflow_paths:
    errors.append('no workflow files were discovered; workflow inventory may be broken')
if checked == 0:
    errors.append('no external actions were discovered; workflow inventory may be broken')

if errors:
    print('SUPPLY_CHAIN_POLICY=fail')
    for error in errors:
        print(f'- {error}')
    sys.exit(1)

print(f'SUPPLY_CHAIN_POLICY=pass external_actions={checked} workflows={len(workflow_paths)}')
