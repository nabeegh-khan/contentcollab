#!/usr/bin/env python3
"""Turn the Actions table of a meeting-notes file into GitHub Issues.

Reads docs/meetings/<date>.md, finds the "## Actions" table (Owner | Action | Due),
and prints one `gh issue create` command per row, assigned to the owner's GitHub
handle, labelled `admin`, with the meeting file as the source. Review the commands,
then run them; nothing is created without that step. Requires the GitHub CLI (gh)
logged in. Rows whose Owner is "All" are assigned to everyone.

    python3 scripts/meeting-actions.py docs/meetings/2026-10-17.md
    python3 scripts/meeting-actions.py docs/meetings/2026-10-17.md | sh
"""
import re
import shlex
import sys

HANDLES = {
    "nabeegh": "nabeegh-khan",
    "milton": "MWang-max",
    "jyotiraditya": "Jyotiraditya7",
    "eyrika": "Oct31yrika",
}


def rows(path):
    text = open(path, encoding="utf-8").read()
    section = text.split("## Actions", 1)[1].split("\n## ", 1)[0]
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 3 and cells[0] not in ("Owner", "-------"):
            yield cells


def assignees(owner):
    if owner.lower().startswith("all"):
        return list(HANDLES.values())
    return [HANDLES[n] for n in HANDLES if n in owner.lower()]


def main(path):
    date = re.search(r"(\d{4}-\d{2}-\d{2})", path).group(1)
    for owner, action, due in rows(path):
        body = f"From the {date} meeting (docs/meetings/{date}.md). Due: {due}."
        cmd = ["gh", "issue", "create", "--title", action, "--body", body, "--label", "admin"]
        for a in assignees(owner):
            cmd += ["--assignee", a]
        print(" ".join(shlex.quote(c) for c in cmd))


if __name__ == "__main__":
    main(sys.argv[1])
