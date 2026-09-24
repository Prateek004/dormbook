#!/usr/bin/env python3
"""
bundle_project.py
=================
Run this script to create sthappit.zip from the current directory.

Usage:
    python bundle_project.py

Output: sthappit.zip (in the current working directory)
"""

import os
import sys
import zipfile
import shutil
from pathlib import Path

# ── Configuration ──────────────────────────────────────────
PROJECT_NAME = "sthappit"
OUTPUT_ZIP   = f"{PROJECT_NAME}.zip"

# Directories and files to EXCLUDE from the zip
EXCLUDE_DIRS = {
    "node_modules", ".git", "__pycache__", ".pytest_cache",
    "dist", "build", "coverage", ".nyc_output",
}
EXCLUDE_FILES = {
    ".env",           # never bundle real secrets
    "*.log",
    "sthappit.db",
    "*.db-shm",
    "*.db-wal",
}
EXCLUDE_EXTENSIONS = {".pyc", ".pyo", ".DS_Store"}


def should_exclude(path: Path) -> bool:
    """Return True if the path should be skipped."""
    # Check each component of the path against excluded dirs
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True

    # Check filename patterns
    name = path.name
    if name in EXCLUDE_FILES:
        return True
    if name.startswith(".") and name not in {".gitignore", ".env.example"}:
        return True
    if path.suffix in EXCLUDE_EXTENSIONS:
        return True

    # The output zip itself
    if name == OUTPUT_ZIP:
        return True

    return False


def bundle(source_dir: Path, output_path: Path) -> None:
    """Walk source_dir and write every non-excluded file into output_path zip."""
    files_added = 0
    total_bytes = 0

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_path in sorted(source_dir.rglob("*")):
            if not file_path.is_file():
                continue

            # Make path relative to source_dir's parent so zip contains sthappit/...
            rel = file_path.relative_to(source_dir.parent)

            if should_exclude(rel):
                continue

            zf.write(file_path, rel)
            size = file_path.stat().st_size
            files_added += 1
            total_bytes += size
            print(f"  + {rel}  ({size:,} bytes)")

    print(f"\n✅ Bundled {files_added} files ({total_bytes:,} bytes uncompressed)")
    print(f"   → {output_path}  ({output_path.stat().st_size:,} bytes compressed)")


def main():
    # Determine project root: the directory containing this script
    script_dir = Path(__file__).parent.resolve()

    # If this script is run from inside the project, use that dir
    project_dir = script_dir
    if project_dir.name != PROJECT_NAME:
        # Try to find it as a sibling/child named 'sthappit'
        candidate = script_dir / PROJECT_NAME
        if candidate.is_dir():
            project_dir = candidate
        # else assume current dir is the project

    output_path = Path.cwd() / OUTPUT_ZIP

    print(f"🗜  Bundling: {project_dir}")
    print(f"   Output:   {output_path}\n")

    if not project_dir.exists():
        print(f"❌ Project directory not found: {project_dir}", file=sys.stderr)
        sys.exit(1)

    # Remove existing zip if present
    if output_path.exists():
        output_path.unlink()
        print(f"   (removed existing {OUTPUT_ZIP})\n")

    bundle(project_dir, output_path)
    print(f"\n🎉 Done! Extract with:  unzip {OUTPUT_ZIP}")


if __name__ == "__main__":
    main()
