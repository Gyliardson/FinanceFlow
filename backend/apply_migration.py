"""FinanceFlow migration inventory helper.

This file is intentionally non-mutating. FinanceFlow migrations include ownership/RLS,
fail-closed historical reconciliation and Supabase Storage-related schema boundaries;
a publishable-key SDK client is not a safe or complete migration runner.

Use this helper to inventory the ordered SQL files, then follow SECURITY_MODEL.md and
docs/CLEAN_ROOM.md for the reviewed application/verification procedure.
"""

from pathlib import Path


MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def migration_files() -> list[Path]:
    """Return the repository SQL migrations in deterministic filename order."""
    return sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9]_*.sql"))


def main() -> int:
    files = migration_files()
    if not files:
        print("No FinanceFlow migration files were found; refusing to guess database state.")
        return 1

    print("FinanceFlow migration inventory (non-mutating):")
    for path in files:
        print(f"- {path.name}")

    print()
    print("This helper does NOT apply migrations automatically.")
    print("Review backend/SECURITY_MODEL.md and docs/CLEAN_ROOM.md before applying SQL.")
    print("Ownership backfill and production credentials require explicit operator review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
