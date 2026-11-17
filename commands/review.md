---
description: Review one pull request picked from the PR review queue
argument-hint: owner/repo#N
---
Review pull request $ARGUMENTS.

1. Collect evidence with the aid-pr skill, or run `AID.pr --repo <owner/repo> --pr <N> --json` if that skill is not installed. If I reviewed this pull request before, also use the aid-pr-delta skill to see what changed since then.
2. Start one subagent to review the diff, and put "$ARGUMENTS" word for word in its prompt.
3. Draft the review and show it to me. Follow any code review guidelines in my instructions. Do not post it.
4. Once I approve, submit it with `gh pr review <N> --repo <owner/repo>` and `--comment`, `--approve`, or `--request-changes`.
