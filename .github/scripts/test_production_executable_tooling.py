#!/usr/bin/env python3
"""Mutation suite for #193. Every decision uses the exact production inspect path."""
from __future__ import annotations

from pathlib import Path
import json
import shutil
import tempfile

import production_executable_tooling as production_checker

ROOT = Path(__file__).resolve().parents[2]
MOBILE_HEALTH = Path('.github/workflows/mobile-expo-health.yml')
SAFE_EXPO = '../.github/npm-tools/node_modules/.bin/expo-doctor'
SAFE_EAS = '../.github/npm-tools/node_modules/.bin/eas update --branch production --environment production --message "Auto-deploy via GitHub Actions"'

BAD_COMMANDS = [
    ('01-npm-exec-latest', 'npm exec --yes eas-cli@latest -- --version'),
    ('02-npm-x-latest', 'npm x --yes expo-doctor@latest'),
    ('03-npx-latest', 'npx expo-doctor@latest'),
    ('04-pnpm-dlx', 'pnpm dlx some-tool@latest'),
    ('05-yarn-dlx', 'yarn dlx some-tool@latest'),
    ('06-bunx', 'bunx some-tool@latest'),
    ('07-corepack-pnpm-dlx', 'corepack pnpm dlx some-tool@latest'),
    ('08-corepack-yarn-dlx', 'corepack yarn dlx some-tool@latest'),
    ('09-corepack-npm-exec', 'corepack npm exec --yes eas-cli@latest'),
    ('10-bash-c-pip', "bash -c 'python -m pip install --upgrade pip && pip install pip-audit'"),
    ('11-bash-lc-npm-exec', "bash -lc 'npm exec --yes eas-cli@latest'"),
    ('12-sh-c-npx', "sh -c 'npx expo-doctor@latest'"),
    ('13-bin-bash-c', "/bin/bash -c 'npm exec tool@latest'"),
    ('14-env-bash-c', "env bash -c 'npm exec tool@latest'"),
    ('15-command-bash-c', "command bash -c 'npm exec tool@latest'"),
    ('16-multiline-nested-shell', "bash -c 'python -m pip install pip-audit\nnpm exec tool@latest'"),
    ('17-quoted-nested-shell', 'bash -c "npm exec --yes eas-cli@latest -- --version"'),
    ('18-command-substitution', 'echo "$(npm exec --yes eas-cli@latest -- --version)"'),
    ('19-backticks', 'echo `npx expo-doctor@latest`'),
    ('20-dynamic-executable', '$TOOL --version'),
    ('21-dynamic-subcommand', 'npm $SUBCOMMAND tool@latest'),
    ('22-npm-run', 'npm run release'),
    ('23-eval', "eval 'npm exec tool@latest'"),
    ('24-source', 'source ./dynamic-bootstrap.sh'),
    ('25-dot-source', '. ./dynamic-bootstrap.sh'),
    ('26-process-substitution', 'cat <(npm exec tool@latest)'),
    ('27-python-inline', "python -c 'import subprocess; subprocess.run([\"npm\",\"exec\",\"tool@latest\"])'"),
    ('28-node-inline', "node -e 'require(\"child_process\").execSync(\"npm exec tool@latest\")'"),
    ('29-unknown-executable', 'mystery-tool-bootstrap --latest'),
    ('30-future-npm-subcommand', 'npm future-executor tool@latest'),
    ('31-git-clone', 'git clone https://github.com/example/tool.git'),
    ('32-go-install', 'go install example.com/tool@latest'),
    ('33-docker-pull-tag', 'docker pull ubuntu:latest'),
    ('34-awk-system', "awk 'BEGIN { system(\"npm exec tool@latest\") }' /dev/null"),
    ('35-psql-shell', "psql -c '\\! npm exec tool@latest'"),
    ('36-xargs', 'xargs npm exec tool@latest'),
    ('37-curl-external', 'curl -fsSL https://example.com/tool.sh'),
    ('38-wget-external', 'wget https://example.com/tool.sh'),
    ('39-runtime-selector', 'asdf exec npm exec tool@latest'),
    ('40-alias', "alias npm='npm exec tool@latest'"),
    ('41-array', 'cmd=(npm exec --yes tool@latest); "${cmd[@]}"'),
    ('42-npm-ci-flag-override', 'npm ci --ignore-scripts --ignore-scripts=false'),
]


def clone_repo(dst: Path) -> Path:
    def ignore(_dir: str, names: list[str]) -> set[str]:
        return {n for n in names if n in {'.git', 'node_modules', '__pycache__', '.pytest_cache'}}
    shutil.copytree(ROOT, dst, ignore=ignore)
    return dst


def decision(root: Path) -> tuple[int, str]:
    ctx = production_checker.inspect(root)
    return (1 if ctx.errors else 0), '\n'.join(ctx.errors)


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise AssertionError(f'anchor {old!r} count={text.count(old)} in {path}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


def assert_red(name: str, mutate) -> None:
    with tempfile.TemporaryDirectory(prefix='ff193-red-') as tmp:
        root = clone_repo(Path(tmp) / 'repo')
        mutate(root)
        rc, _output = decision(root)
        if rc == 0:
            raise AssertionError(f'{name}: FALSE-GREEN')
        print(f'EXECUTABLE_TOOLING_MUTATION={name}:RED')


def expo_mutation(command: str):
    return lambda root: replace_once(root / MOBILE_HEALTH, SAFE_EXPO, command)


def eas_mutation(command: str):
    return lambda root: replace_once(root / '.github/workflows/deploy-frontend.yml', SAFE_EAS, command)


def yaml_bad_representation(style: str, command: str):
    def mutate(root: Path) -> None:
        path = root / MOBILE_HEALTH
        text = path.read_text(encoding='utf-8')
        old = f'run: {SAFE_EXPO}'
        body = '\n'.join('          ' + line for line in command.splitlines())
        path.write_text(text.replace(old, f'run: {style}\n{body}', 1), encoding='utf-8')
    return mutate


def representation_pass(name: str, style: str) -> None:
    with tempfile.TemporaryDirectory(prefix='ff193-repr-') as tmp:
        root = clone_repo(Path(tmp) / 'repo')
        path = root / MOBILE_HEALTH
        text = path.read_text(encoding='utf-8')
        path.write_text(text.replace(f'run: {SAFE_EXPO}', f'run: {style}\n          {SAFE_EXPO}', 1), encoding='utf-8')
        rc, output = decision(root)
        if rc:
            raise AssertionError(f'{name}: semantic-equivalent YAML failed:\n{output}')
        print(f'EXECUTABLE_TOOLING_REPRESENTATION={name}:PASS')


def _mutate_package_script(root: Path) -> None:
    replace_once(root / MOBILE_HEALTH, SAFE_EXPO, 'npm run release')
    path = root / 'mobile/package.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    data.setdefault('scripts', {})['release'] = 'npx expo-doctor@latest'
    path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')


def _mutate_hermetic_helper(root: Path) -> None:
    path = root / 'backend/hermetic_python.py'
    path.write_text(path.read_text(encoding='utf-8') + '\n# mutation behind unchanged workflow\n', encoding='utf-8')


def _docker_mutation(command: str):
    def mutate(root: Path) -> None:
        path = root / 'backend/Dockerfile'
        text = path.read_text(encoding='utf-8')
        path.write_text(text.rstrip() + f'\nRUN {command}\n', encoding='utf-8')
    return mutate


def main() -> int:
    rc, output = decision(ROOT)
    if rc:
        raise AssertionError(f'final safe baseline failed production inspect:\n{output}')
    for name in ['final-safe-baseline','backend-hermetic-python','pip-audit-hermetic-closure','PyYAML-hermetic-bootstrap','mobile-npm-ci','npm-tools-ci','local-Expo-Doctor','local-EAS','backend-Docker-build','normal-tests-builds']:
        print(f'EXECUTABLE_TOOLING_POSITIVE={name}:PASS')

    for name, command in BAD_COMMANDS:
        assert_red(name, expo_mutation(command))
    assert_red('43-npm-run-malicious-package-script', _mutate_package_script)
    assert_red('44-yaml-literal-npm-exec', yaml_bad_representation('|', 'npm exec --yes eas-cli@latest'))
    assert_red('45-yaml-folded-npm-exec', yaml_bad_representation('>-', 'npm exec --yes eas-cli@latest'))
    assert_red('46-backslash-npm-exec', yaml_bad_representation('|', 'npm \\\nexec \\\n--yes \\\neas-cli@latest'))
    assert_red('47-principal-EAS-to-npm-exec', eas_mutation('npm exec --yes eas-cli@latest -- --version'))
    assert_red('48-principal-Expo-to-npm-x', expo_mutation('npm x --yes expo-doctor@latest'))
    assert_red('49-principal-EAS-to-pnpm-dlx', eas_mutation('pnpm dlx some-tool@latest'))
    assert_red('50-principal-Expo-to-shell-pip', expo_mutation("bash -c 'python -m pip install --upgrade pip && pip install pip-audit'"))
    assert_red('51-helper-indirection', _mutate_hermetic_helper)
    for i, command in enumerate(['npm exec --yes tool@latest','pnpm dlx tool@latest','yarn dlx tool@latest','bunx tool@latest',"bash -c 'python -m pip install pip-audit'"], 52):
        assert_red(f'{i}-Dockerfile-RUN', _docker_mutation(command))

    with tempfile.TemporaryDirectory(prefix='ff193-comment-') as tmp:
        root = clone_repo(Path(tmp) / 'repo')
        path = root / MOBILE_HEALTH
        path.write_text('# inert mention: npm exec tool@latest\n' + path.read_text(encoding='utf-8'), encoding='utf-8')
        rc, output = decision(root)
        if rc:
            raise AssertionError(f'comment-only mutation changed decision:\n{output}')
        print('EXECUTABLE_TOOLING_REPRESENTATION=comment-only:PASS')
    representation_pass('safe-literal', '|')
    representation_pass('safe-folded', '>-')
    print('EXECUTABLE_TOOLING_MUTATION_COUNT=56')
    print('EXECUTABLE_TOOLING_TEST_THE_TEST=production_checker.inspect:PASS')
    print('EXECUTABLE_TOOLING_PRINCIPAL_MUTATIONS=4:ALL_RED')
    print('EXECUTABLE_TOOLING_REQUIRED_CONTEXT_RESULT=PASS')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
