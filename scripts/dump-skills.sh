#!/usr/bin/env bash
# Resolve skill symlinks into real files so the repo publishes actual content
# instead of dangling symlink stubs. Idempotent: plain dirs are skipped.
#
# Usage: scripts/dump-skills.sh [--check]
#   --check  report what would be resolved, change nothing
set -euo pipefail

SKILLS_DIR="$(cd "$(dirname "$0")/.." && pwd)/agent/skills"
check=0
[ "${1:-}" = "--check" ] && check=1

resolved=0
for link in "$SKILLS_DIR"/*/; do
	name="$(basename "$link")"
	[ -L "$SKILLS_DIR/$name" ] || continue
	target="$(readlink "$SKILLS_DIR/$name")"
	if [ ! -d "$target" ]; then
		echo "MISSING: $name -> $target" >&2
		continue
	fi
	if [ "$check" = 1 ]; then
		echo "would resolve: $name -> $target"
		resolved=$((resolved + 1))
		continue
	fi
	rm "$SKILLS_DIR/$name"
	cp -R "$target/." "$SKILLS_DIR/$name/"
	echo "resolved: $name -> $target"
	resolved=$((resolved + 1))
done

echo "done: $resolved skill(s) resolved"
