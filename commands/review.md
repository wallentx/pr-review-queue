---
description: Review one pull request picked from the PR review queue
argument-hint: owner/repo#N
---
Review pull request $ARGUMENTS.

1. Collect evidence with the aid-pr skill, or run `AID.pr --repo <owner/repo> --pr <N> --json` if that skill is not installed. If I reviewed this pull request before, also use the aid-pr-delta skill to see what changed since then.
2. Start one subagent to review the diff, and put "$ARGUMENTS" word for word in its prompt.
3. Draft the review and show it to me. Follow any code review guidelines in my instructions. Do not post it.
4. Call the `offer_choices` tool from the pr-review-queue plugin with the next steps that fit the findings, recommended first. End with one sentence that names the recommended button by its glyph, such as "If you want me to approve the pull request, select ✓, or tell me what to do otherwise." If the tool is not available, ask me in words.
5. Once I choose, submit it as one review. Use `gh pr review <N> --repo <owner/repo>` with `--comment`, `--approve`, or `--request-changes` when it has no inline comments. With inline comments, POST it to `repos/<owner/repo>/pulls/<N>/reviews` with `gh api`, giving the head commit, the event, and the comments.
