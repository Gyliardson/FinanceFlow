from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CERTIFIED_PYTHON_MINOR = "3.12"


def test_documented_python_runtime_matches_certified_baseline():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    clean_room = (ROOT / "docs" / "CLEAN_ROOM.md").read_text(encoding="utf-8")
    dockerfile = (ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert readme.count("Python **3.12**") == 2
    assert "Python 3.10+" not in readme
    assert "Recommended CI-equivalent runtime: Python 3.12." in clean_room
    assert "FROM python:3.12-slim" in dockerfile
    assert "python-version: '3.12'" in ci


def test_runtime_claim_does_not_imply_unverified_multi_version_support():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Python **3.12**" in readme
    assert "Python 3.11" not in readme
    assert "Python 3.10" not in readme
