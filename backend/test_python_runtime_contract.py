from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CERTIFIED_PYTHON_MINOR = "3.12"
CERTIFIED_PYTHON_PATCH = "3.12.13"
README_RUNTIME_REQUIREMENT = f"Python **{CERTIFIED_PYTHON_MINOR}**"


def test_documented_python_runtime_matches_certified_baseline():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    clean_room = (
        ROOT / "docs" / "operations" / "CLEAN_ROOM.md"
    ).read_text(encoding="utf-8")
    dockerfile = (ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert readme.count(README_RUNTIME_REQUIREMENT) == 1
    assert "Python 3.10+" not in readme
    assert f"Recommended CI-equivalent runtime: Python {CERTIFIED_PYTHON_MINOR}." in clean_room
    assert f"FROM python:{CERTIFIED_PYTHON_PATCH}-slim@sha256:" in dockerfile
    assert ci.count(f"python-version: '{CERTIFIED_PYTHON_PATCH}'") >= 2
    assert f"python-version: '{CERTIFIED_PYTHON_MINOR}'" not in ci


def test_readme_does_not_advertise_a_broader_python_floor():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    requirements = [line.strip() for line in readme.splitlines() if line.startswith("- Python ")]
    assert requirements == [f"- {README_RUNTIME_REQUIREMENT}."]
