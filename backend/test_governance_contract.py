from pathlib import Path

from strictyaml import load


REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "authenticated-data-plane.yml"
GOVERNANCE_PATH = REPO_ROOT / "docs" / "GOVERNANCE.md"
QUALITY_EVIDENCE_PATH = REPO_ROOT / "docs" / "QUALITY_EVIDENCE.md"
REQUIRED_CONTEXT = "PostgreSQL authenticated write boundary"


def test_authenticated_data_plane_is_an_always_on_main_pr_context() -> None:
    """Guard the repository-side half of the remote required-check contract.

    GitHub ruleset membership is intentionally *not* asserted here: proving the
    effective remote ruleset from CI would require privileged repository-settings
    credentials and would turn a local regression test into an admin-coupled
    network check. The effective ruleset is verified separately through GitHub's
    API during release certification.
    """

    workflow = load(WORKFLOW_PATH.read_text(encoding="utf-8")).data
    pull_request = workflow["on"]["pull_request"]

    assert set(pull_request["branches"]) == {"main", "portfolio/revamp-2026"}
    assert "paths" not in pull_request
    assert "paths-ignore" not in pull_request

    job_names = {
        job.get("name")
        for job in workflow["jobs"].values()
        if isinstance(job, dict)
    }
    assert REQUIRED_CONTEXT in job_names


def test_governance_docs_record_the_authenticated_data_plane_context() -> None:
    governance = GOVERNANCE_PATH.read_text(encoding="utf-8")
    quality_evidence = QUALITY_EVIDENCE_PATH.read_text(encoding="utf-8")

    assert f"`{REQUIRED_CONTEXT}`" in governance
    assert "`Authenticated data plane`" in quality_evidence
    assert f"`{REQUIRED_CONTEXT}`" in quality_evidence
