# pr-review-queue

pr-review-queue is a Claude Code mod that lists the GitHub pull requests waiting on your review in a row above the prompt. Picking a pull request from the list starts a review of it, and each row shows whether its review is queued, running, finished, or posted.

## Requirements

1. The mod reads the queue with `AID.review-queue` from [AIDecisions-Toolkit](https://github.com/wallentx/AIDecisions-Toolkit), so you need access to that repository and the toolkit installed. Its `./install.sh` builds the suite into `~/.local/bin`. The mod finds `AID.review-queue` on Claude Code's PATH, and the `aidPath` option takes an absolute path when it is somewhere else.
2. `AID.review-queue` calls GitHub through the `gh` CLI, so `gh auth status` must show you signed in.
3. Picking a pull request runs a slash command with `owner/repo#N` as its argument. The plugin ships `/pr-review-queue:review` for this, so the queue works without extra setup. The `reviewCommand` option names a different command when you want your own.

## Install

At the prompt of a Claude Code terminal session, run:

```
/plugin install pr-review-queue --marketplace wallentx/pr-review-queue
```

Claude Code asks `Add marketplace?`, which you answer with `y`. You then choose a scope, and the user scope comes first. A screen for the options below follows, and the mod is active in that session once the install finishes.

From a shell, run:

```sh
claude plugin install pr-review-queue --marketplace wallentx/pr-review-queue
```

In the desktop app, click + next to the prompt box, then Plugins, then Add marketplace with `wallentx/pr-review-queue`, then Add plugin.

## Use

The queue starts off in every session. Run `/pr-queue on` to turn it on and `/pr-queue off` to turn it off, and `/pr-queue` with no argument toggles it. The switch applies to the session you run it in, so other open sessions and new ones keep their own setting. While the queue is off, the session runs no checks.

Sessions that have the queue on and run the same query share one result. The query is the `aidPath`, `owner` and `workspace` options, plus the session's working directory when `workspace` is empty, because `AID.review-queue` infers the owner from it. The query also covers `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST` and `GH_CONFIG_DIR`, which choose the GitHub account and host, so sessions signed in differently keep separate results. Those values reach the cache only as part of a hash in the file name. The shared result is a file under `${XDG_CACHE_HOME:-~/.cache}/pr-review-queue/`. Each session reads that file every 30 seconds. When the result there is older than 5 minutes, one session claims the next check, runs `AID.review-queue`, and writes the new result, and the other sessions pick it up on their next read. A session that turns the queue on while a recent result exists shows that result at once. A claim lapses after 150 seconds, so a session that exits mid-check does not stall the others. A shared file that still fails to parse after a minute was left truncated, and the next session to check writes over it. When the cache directory cannot be written, or neither `XDG_CACHE_HOME` nor `HOME` is set, the session shows a toast and runs its own check every 5 minutes.

When pull requests are waiting, a row reads `◧ Reviews waiting: N` followed by a triangle. The triangle points right while the list is hidden and down while it is shown. Click anywhere on the text or the triangle, or press ctrl+x then Tab to focus it and press Enter, to show or hide the list. Each line shows one pull request as `owner/repo#N` in fixed colors, followed by its title cut to fit the width. Picking a gray line runs the review command for that pull request.

Clicking `◧` opens the list if it is closed, turns it into `◨`, and moves every line to the right to show a red `⨯` at its start. Clicking `◨` again removes the `⨯` marks. Clicking a `⨯` hides that pull request from the list and from the count in every session. Other open sessions pick up the change within 30 seconds.

While `◨` shows and some pull requests are hidden, a green `⟲` appears beside it. Clicking that `⟲` lists the hidden pull requests struck through, each with its own green `⟲` at its start, and clicking a row's `⟲` restores that pull request to the list. A hidden pull request that stops waiting for your review, because you posted one or it was merged or closed, is forgotten after the next complete check of the query that hid it. Sessions with a different owner, workspace, or GitHub account run a different query, so their checks leave it hidden. While the hidden pull requests are listed, they get room first, and the waiting ones fill the rest of the 9 lines. `/pr-queue unhide owner/repo#N` restores one pull request from the prompt, and `/pr-queue unhide` restores them all.

| Marker | Meaning |
| --- | --- |
| gray `○` | The pull request waits for review. Picking it starts one. |
| yellow `○` | The review command ran, and no subagent has taken the review yet. |
| pulsing `●` | A subagent is reviewing it. The dot cycles between yellow and blue while the model reads its input or a tool runs, and between yellow and red while the model writes. |
| green `●` | The review finished, and its draft waits for you. |
| red `●` | The review ended in an error or a refusal. Picking it starts another. |
| blue `✓` | The review was posted. The line stays until a complete check no longer lists the pull request, and it no longer counts as waiting. |

A failed check shows a red line with the reason, so a failure never reads as an empty queue.

## Choice buttons

After the agent drafts a review, it calls the `offer_choices` tool, which the mod registers, to put buttons after `owner/repo#N`, such as `[✓] [✓🗩 ] [⊘]`. The brackets are light blue. Each button shows one or two glyphs from a fixed palette of GitHub review actions, and the agent writes what each button does for that review. Two glyphs combine actions, so `✓🗩` approves with comments. Clicking a button sends its action to the agent as your own message, starting with its glyph, and removes the buttons. Posting a review also removes them. You can still type an answer instead. Offering buttons opens a collapsed list. When the pull request is hidden or falls past the 9 lines the list draws, the tool tells the agent that the buttons are not visible, and the agent asks you in words.

| Glyph | Usual meaning |
| --- | --- |
| green `✓` | Approve. |
| `🗩` | Comment. |
| `🗈` | Post suggested changes. |
| red `⊘` | Request changes. |

The meanings guide the agent and are not enforced. The mod refuses a glyph outside the palette, or more than two glyphs on one button. Most fonts draw `🗩` and `🗈` two cells wide, so each is followed by a space for it to spill into.

## Review command

`/pr-review-queue:review owner/repo#N` collects the pull request's evidence with `AID.pr`, starts one subagent to review the diff, and shows you a draft review with choice buttons on its line. It posts nothing until you pick a button or answer in words. It then submits the review with `gh pr review`, or with a `gh api` POST when the review has inline comments. You can also type the command yourself for a pull request that is not in the queue.

To use your own command, set `reviewCommand` to its name without the slash. The status markers below depend on what that command does, so a replacement needs to start a subagent with `owner/repo#N` in its prompt and post with `gh pr review` or a `gh api` POST to the pull request's reviews for the line to pulse, turn green, and then show a check.

## Status tracking

A line turns yellow when the review command runs with `owner/repo#N` in its arguments, whether you picked the line or typed the command. The main turn whose prompt names `owner/repo#N` is that review's own turn. When a subagent whose prompt contains `owner/repo#N` starts, the line becomes that subagent's, and its dot pulses until the subagent's turn ends.

How the turn ends sets the dot. An answer turns it green, an error or a refusal turns it red, and ctrl+c turns it gray again so the line can be picked again. When the review's own main turn ends before any subagent started, the same rule applies, so a review the model did in the main conversation turns green. Each queue check and every 2 seconds of pulsing also compare the tracked subagents with the engine's agent list, so a subagent that was killed or vanished without an event still turns its dot gray.

A line turns into a blue check when a Bash call that posts a review succeeds: `gh pr review N --repo owner/repo` with `--approve`, `--request-changes`, or `--comment`, or a `gh api` POST to `repos/owner/repo/pulls/N/reviews`. The line stays listed until a later complete check no longer lists the pull request.

## Options

You set these on the install screen or later in `/config`.

| Option | Default | Effect |
| --- | --- | --- |
| `aidPath` | `AID.review-queue` | The executable, by name on PATH or as an absolute path. |
| `owner` | empty | The GitHub organization or user to list. Empty lets `AID.review-queue` infer it from its config or the workspace's git remotes. |
| `workspace` | empty | An absolute directory to infer the owner from. Empty uses the session's working directory. |
| `reviewCommand` | `pr-review-queue:review` | The slash command, without its slash, that picking a pull request runs. |

## Development

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`claude --plugin-dir .` starts a session with the mod loaded from this folder and reloads it when a file changes. The engine writes type definitions to `.claude-plugin/types/` when it loads the mod, and `tsc -p .` type-checks the mod after that.
