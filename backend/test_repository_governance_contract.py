from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "authenticated-data-plane.yml"
GOVERNANCE = REPO_ROOT / "docs" / "GOVERNANCE.md"
QUALITY = REPO_ROOT / "docs" / "QUALITY_EVIDENCE.md"
REQUIRED_CONTEXT = "PostgreSQL authenticated write boundary"


def _pull_request_block(workflow: str) -> str:
    marker = "  pull_request:\n"
    start = workflow.index(marker) + len(marker)
    end = workflow.index("  push:\n", start)
    return workflow[start:end]


def test_authenticated_write_boundary_is_always_on_for_promotion_prs() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    pull_request = _pull_request_block(workflow)

    assert "      - main\n" in pull_request
    assert "      - portfolio/revamp-2026\n" in pull_request
    assert "paths:" not in pull_request
    assert "paths-ignore:" not in pull_request
    assert f"    name: {REQUIRED_CONTEXT}\n" in workflow


def test_required_authenticated_write_context_is_documented() -> None:
    governance = GOVERNANCE.read_text(encoding="utf-8")
    quality = QUALITY.read_text(encoding="utf-8")

    assert f"- `{REQUIRED_CONTEXT}`;" in governance
    assert REQUIRED_CONTEXT in quality
    assert "re-reading the effective remote ruleset" in governance
    assert "does not replace re-reading the remote GitHub ruleset" in quality
