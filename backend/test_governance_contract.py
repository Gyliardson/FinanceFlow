from pathlib import Path

from strictyaml import load


REPO_ROOT = Path(__file__).resolve().parent.parent
GOVERNANCE_PATH = REPO_ROOT / "docs" / "GOVERNANCE.md"
QUALITY_EVIDENCE_PATH = REPO_ROOT / "docs" / "QUALITY_EVIDENCE.md"

ALWAYS_ON_RELEASE_CONTEXTS = {
    REPO_ROOT / ".github" / "workflows" / "authenticated-data-plane.yml":
        "PostgreSQL authenticated write boundary",
    REPO_ROOT / ".github" / "workflows" / "mobile-expo-health.yml":
        "Expo Doctor and build smoke",
    REPO_ROOT / ".github" / "workflows" / "backend-container.yml":
        "Build production backend image",
    REPO_ROOT / ".github" / "workflows" / "supply-chain-policy.yml":
        "Immutable Actions and reproducible tooling",
}


def test_release_security_and_runtime_contexts_are_always_on_for_promotion_prs() -> None:
    """Guard the repository-side half of the remote required-check contract.

    GitHub ruleset membership is intentionally *not* asserted here: proving the
    effective remote ruleset from CI would require privileged repository-settings
    credentials. Release certification re-reads the effective ruleset remotely.
    """

    for workflow_path, required_context in ALWAYS_ON_RELEASE_CONTEXTS.items():
        workflow = load(workflow_path.read_text(encoding="utf-8")).data
        pull_request = workflow["on"]["pull_request"]

        assert set(pull_request["branches"]) == {"main", "portfolio/revamp-2026"}
        assert "paths" not in pull_request
        assert "paths-ignore" not in pull_request

        job_names = {
            job.get("name")
            for job in workflow["jobs"].values()
            if isinstance(job, dict)
        }
        assert required_context in job_names


def test_governance_docs_record_always_on_contexts_and_remote_drift() -> None:
    governance = GOVERNANCE_PATH.read_text(encoding="utf-8")
    quality_evidence = QUALITY_EVIDENCE_PATH.read_text(encoding="utf-8")

    for required_context in ALWAYS_ON_RELEASE_CONTEXTS.values():
        assert f"`{required_context}`" in governance

    assert "MANUAL GOVERNANCE ACTION" in governance
    assert "`Authenticated data plane`" in quality_evidence
    assert "`PostgreSQL authenticated write boundary`" in quality_evidence
