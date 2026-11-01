#!/usr/bin/env python3
"""Mechanical half of /coherence: checks the repository's guidance files against the tree.

Run from anywhere inside the repository: python3 .claude/skills/coherence/check.py
Prints one line per finding and exits 1 when there are findings, 0 when there are none.

Checks:
  - every repository path written in backticks in a guidance file exists (paths starting with ~, /, $ or holding
    <placeholders> are runtime or example paths and are skipped)
  - every glob in a rule's `paths:` front matter matches at least one tracked file
  - every SESSIONS_* variable a guidance file names is used somewhere in the code
"""
import fnmatch
import re
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
    return Path(out.stdout.strip())


def tracked(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True)
    return out.stdout.split()


def guidance_files(root: Path) -> list[Path]:
    found = [root / "CLAUDE.md", root / "CONTRIBUTING.md"]
    found += sorted((root / ".claude" / "rules").glob("*.md"))
    found += sorted((root / ".claude" / "skills").glob("*/SKILL.md"))
    found += sorted((root / "plugins").glob("*/README.md"))
    found += sorted((root / "dev").glob("*/*.md"))
    return [p for p in found if p.is_file()]


def bases(root: Path, doc: Path) -> list[Path]:
    """Folders a relative path in this document may be relative to: the repository, the document's folder and every
    plugin's folder (repository-wide documents describe a plugin's files relative to it, as in "In plugins/sessions:")."""
    out = [root, doc.parent]
    out += sorted(p for p in (root / "plugins").glob("*") if p.is_dir())
    return out


PATHLIKE = re.compile(r"^[A-Za-z0-9._\-]+(/[A-Za-z0-9._\-*]+)*/?$")


def candidate_paths(text: str) -> set[str]:
    out = set()
    for token in re.findall(r"`([^`\n]+)`", text):
        token = token.strip()
        if "/" not in token or " " in token or token.startswith(("~", "/", "$", "http", "-")):
            continue
        token = token.split(":")[0]  # path:line references
        if "/" not in token.rstrip("/"):
            continue  # one segment (`alive/`, `bin/`): too ambiguous, often a folder the plugin makes at run time
        if "<" in token or not PATHLIKE.match(token) or token.startswith("."):
            if not token.startswith((".claude/", ".github/", ".githooks/")):
                continue
        out.add(token)
    return out


def exists(root: Path, doc: Path, path: str, files: list[str]) -> bool:
    for base in bases(root, doc):
        target = (base / path.rstrip("/"))
        if "*" in path:
            pattern = str(target.relative_to(root)) if target.is_relative_to(root) else str(target)
            if path.endswith("/"):
                pattern += "/*"  # a folder glob: some tracked file inside it
            if any(fnmatch.fnmatch(f, pattern) for f in files):
                return True
        elif target.exists():
            return True
    return False


def rule_globs(rule: Path) -> list[str]:
    text = rule.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return []
    return re.findall(r"^\s*-\s*[\"']?([^\"'\n]+)[\"']?\s*$", m.group(1), re.M)


def main() -> int:
    root = repo_root()
    files = tracked(root)
    code = "\n".join((root / f).read_text(errors="ignore") for f in files
                     if f.endswith((".ts", ".tsx", ".sh", ".py")) or "/setup/" in f or f.endswith("/ccc"))
    findings = []
    for doc in guidance_files(root):
        text = doc.read_text()
        name = doc.relative_to(root)
        for path in sorted(candidate_paths(text)):
            if not exists(root, doc, path, files):
                findings.append(f"{name}: names `{path}`, which isn't in the repository")
        for var in sorted(set(re.findall(r"\bSESSIONS_[A-Z_]+\b", text))):
            if var not in code:
                findings.append(f"{name}: names {var}, which no code uses")
    for rule in sorted((root / ".claude" / "rules").glob("*.md")):
        for glob in rule_globs(rule):
            if not any(fnmatch.fnmatch(f, glob) for f in files):
                findings.append(f"{rule.relative_to(root)}: paths entry `{glob}` matches no tracked file")
    for line in findings:
        print(line)
    print(f"{len(findings)} finding(s) in {len(guidance_files(root))} guidance files")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
