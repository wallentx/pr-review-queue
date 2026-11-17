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

The queue starts off. Run `/pr-queue on` to turn it on and `/pr-queue off` to turn it off, and `/pr-queue` with no argument toggles it. The setting persists across sessions. While the queue is on, it checks GitHub when the session starts and every 5 minutes after that. While it is off, it runs no checks.

When pull requests are waiting, a row reads `Reviews waiting: N` with a `[ Show ]` button. Click it, or press ctrl+x then Tab to focus the row and press `s`, to show or hide the list. Each line shows one pull request as `owner/repo#N` in fixed colors, followed by its title cut to fit the width. Picking a gray line runs the review command for that pull request.

| Marker | Meaning |
| --- | --- |
| gray `○` | The pull request waits for review. |
| red `●` | A review of it is running. |
| green `●` | The review finished, and its results wait to be posted. |
| (removed) | The review was posted. |

A failed check shows a red line with the reason, so a failure never reads as an empty queue.

## Review command

`/pr-review-queue:review owner/repo#N` collects the pull request's evidence with `AID.pr`, starts one subagent to review the diff, and shows you a draft review. It posts nothing until you approve the draft, and it then submits the review with `gh pr review`. You can also type the command yourself for a pull request that is not in the queue.

To use your own command, set `reviewCommand` to its name without the slash. The status markers below depend on what that command does, so a replacement needs to start a subagent with `owner/repo#N` in its prompt and post with `gh pr review` for the line to turn green and then disappear.

## Status tracking

A line turns red when the review command runs with `owner/repo#N` in its arguments, whether you picked the line or typed the command. It turns green when a subagent whose prompt contains `owner/repo#N` finishes. It disappears when a Bash call of `gh pr review N --repo owner/repo` with `--approve`, `--request-changes`, or `--comment` succeeds. A posted pull request stays hidden until a later check no longer lists it, and a new review request after that shows it gray again.

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
