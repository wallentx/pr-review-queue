import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Queue, QueueItem, ReviewStatus } from '../types'

const POLL_MS = 5 * 60 * 1000
const MAX_ROWS = 9
const COMMAND = 'pr-queue'

const isEnabled = atom({ plugin: 'pr-review-queue', key: 'isEnabled' } as const, false)
const isExpanded = atom({ plugin: 'pr-review-queue', key: 'isExpanded' } as const, false)
// Change a tag when its value's fields change, so a stale stored value is dropped.
const queue = atom({ plugin: 'pr-review-queue', key: 'queue' } as const, null, { shape: 'queue-2' })
const statuses = atom({ plugin: 'pr-review-queue', key: 'statuses' } as const, {}, { shape: 'statuses-1' })
const agents = atom({ plugin: 'pr-review-queue', key: 'agents' } as const, {}, { shape: 'agents-1' })

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF_RE = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\/pull\/)(\d+)/g

function refOf(item: { repo: string; number: number }): string {
  return `${item.repo}#${item.number}`
}

function repoOf(raw: any): string {
  if (typeof raw?.repo === 'string') return raw.repo
  const r = raw?.repo ?? raw?.repository
  return String(r?.full_name ?? r?.nameWithOwner ?? '')
}

function parseItems(list: unknown): QueueItem[] {
  if (!Array.isArray(list)) return []
  const items: QueueItem[] = []
  for (const raw of list as any[]) {
    const repo = repoOf(raw)
    const number = Number(raw?.number)
    if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0) continue
    const kind = raw?.kind === 'new' || raw?.kind === 're_review' ? raw.kind : 'unknown'
    items.push({ repo, number, title: String(raw?.title ?? ''), kind })
  }
  return items
}

/** Every `owner/repo#N` or `owner/repo/pull/N` in a text, as `owner/repo#N`. */
function refsIn(text: string): string[] {
  return Array.from(text.matchAll(REF_RE), m => `${m[1]}#${m[2]}`)
}

/** The refs a shell command posted a review to with `gh pr review N --repo owner/repo --approve|...`. */
function postedRefs(command: string): string[] {
  const refs: string[] = []
  for (const part of command.split(/&&|\|\||;|\n/)) {
    if (!/\bgh\s+pr\s+review\b/.test(part) || !/--(approve|request-changes|comment)\b|\s-[arc]\b/.test(part)) continue
    const repo = part.match(/(?:--repo|-R)[\s=]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1]
    const number = part.match(/\bgh\s+pr\s+review\s+(?:-\S+\s+\S+\s+)*?(\d+)\b/)?.[1]
    if (repo && number) refs.push(`${repo}#${number}`)
  }
  return refs
}

/** Cuts text to at most `width` characters, ending in an ellipsis when cut. */
function fit(text: string, width: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (width <= 0) return ''
  return chars.length <= width ? chars.join('') : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

type Config = { aidPath: string; owner: string; workspace: string; reviewCommand: string }

function configOf(options: Record<string, unknown> | undefined): Config {
  const text = (key: string, fallback: string) => {
    const value = options?.[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    aidPath: text('aidPath', 'AID.review-queue'),
    owner: text('owner', ''),
    workspace: text('workspace', ''),
    reviewCommand: text('reviewCommand', 'pr-review-queue:review').replace(/^\//, ''),
  }
}

/** The AID.review-queue command line for the configured owner and workspace. */
function queueArgv(config: Config): string[] {
  const argv = [config.aidPath, '--json']
  if (config.owner) argv.push('--owner', config.owner)
  if (config.workspace) argv.push('--workspace', config.workspace)
  return argv
}

let config: Config = configOf(undefined)
let timer: { cancel: () => void } | undefined

async function poll($: EngineInterface): Promise<void> {
  let result: Queue
  try {
    // Exit 3 still prints valid JSON, so the exit code is not checked here.
    const { stdout } = await $.process.run(queueArgv(config), { timeoutMs: 120_000 })
    const data = JSON.parse(stdout)
    const status = data?.sources?.search?.status
    if (status !== 'ok') {
      result = { kind: 'error', reason: `search status is ${String(status)}` }
    } else {
      result = {
        kind: 'ok',
        total: Number(data.summary?.total ?? 0),
        isNew: Number(data.summary?.new ?? 0),
        reReview: Number(data.summary?.re_review ?? 0),
        isComplete: data.complete === true,
        items: parseItems(data.items),
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : 'the command failed'
    result = { kind: 'error', reason: `${config.aidPath} did not run (${detail})` }
  }
  // A check that finishes after the queue was turned off is discarded.
  if (!(await read($, isEnabled))) return
  await update($, queue, () => result)
  if (result.kind === 'ok') {
    // A PR the queue no longer lists drops its status, so a later re-request starts gray again.
    const listed = new Set(result.items.map(refOf))
    await update($, statuses, all =>
      Object.fromEntries(Object.entries(all).filter(([ref]) => listed.has(ref))),
    )
  }
}

function startPolling($: EngineInterface): void {
  timer?.cancel()
  void poll($)
  timer = $.clock.every(POLL_MS, () => void poll($))
}

async function stopPolling($: EngineInterface): Promise<void> {
  timer?.cancel()
  timer = undefined
  await update($, queue, () => null)
  await update($, isExpanded, () => false)
}

async function markRunning($: EngineInterface, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return
  await update($, statuses, all => {
    const marked: Record<string, ReviewStatus> = { ...all }
    for (const ref of refs) {
      if (marked[ref] !== 'posted') marked[ref] = 'running'
    }
    return marked
  })
}

export const register: Register = (on, options) => {
  config = configOf(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Turn the PR review queue on or off (on, off, or no argument to toggle)',
    })
    const stored = (await $.store.get('isEnabled')) === true
    await update($, isEnabled, () => stored)
    if (stored) startPolling($)
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, isEnabled)
    const wanted = arg === 'on' ? true : arg === 'off' ? false : !current
    await $.store.set('isEnabled', wanted)
    await update($, isEnabled, () => wanted)
    if (wanted) {
      startPolling($)
      return { text: 'The PR review queue is on. It checks your review queue every 5 minutes.' }
    }
    await stopPolling($)
    return { text: 'The PR review queue is off.' }
  })

  // A review started from the queue or typed by hand marks its PRs red.
  on('command.run', async ($, e, next) => {
    if (e.command === config.reviewCommand) await markRunning($, refsIn(e.args))
    return next(e)
  })

  // A subagent whose prompt names a running PR is that PR's reviewer.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!started.agentId) return started
    const running = Object.entries(await read($, statuses))
      .filter(([, status]) => status === 'running')
      .map(([ref]) => ref)
    const named = new Set(refsIn(e.prompt))
    const ref = running.find(r => named.has(r))
    if (ref) {
      const id = started.agentId
      await update($, agents, all => ({ ...all, [id]: ref }))
    }
    return started
  })

  // The reviewer's last turn turns its PR green: finished, not yet posted.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const ref = (await read($, agents))[id]
      if (ref !== undefined) {
        await update($, statuses, (all): Record<string, ReviewStatus> => (all[ref] === 'running' ? { ...all, [ref]: 'done' } : all))
        await update($, agents, all => Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)))
      }
    }
    return next(e)
  })

  // A successful `gh pr review` removes the PR from the queue right away.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || ran.deny !== undefined) return ran
    const refs = postedRefs(e.command)
    if (refs.length > 0) {
      await update($, statuses, all => {
        const marked: Record<string, ReviewStatus> = { ...all }
        for (const ref of refs) marked[ref] = 'posted'
        return marked
      })
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isEnabled))) {
      return next(e)
    }
    const q = await read($, queue)
    if (q === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    if (q.kind === 'error') {
      return (
        <Box>
          <Text color="error">The PR review check failed: {q.reason}</Text>
        </Box>
      )
    }

    const status = await read($, statuses)
    const visible = q.items.filter(item => status[refOf(item)] !== 'posted')
    const hidden = q.items.length - visible.length
    const total = Math.max(0, q.total - hidden)
    if (total === 0) {
      return next(e)
    }

    const expanded = await read($, isExpanded)
    const header = (
      <Box flexDirection="row">
        <Text color="warning">
          Reviews waiting: {total}
          {q.isComplete ? '' : ' (partial)'}{' '}
        </Text>
        <Button
          key="toggle"
          label={expanded ? 'Hide' : 'Show'}
          hotkey="s"
          onPress={() => update($, isExpanded, v => !v)}
        />
      </Box>
    )

    if (!expanded) {
      return header
    }

    const columns = e.props.bodyColumns > 0 ? e.props.bodyColumns : 80
    const rows = visible.slice(0, MAX_ROWS)
    return (
      <Box flexDirection="column">
        {header}
        {rows.map(item => {
          const ref = refOf(item)
          const state = status[ref]
          const [org, repo] = item.repo.split('/')
          // Marker and spaces take 3 columns; one more keeps the row off the last column.
          const room = columns - 4 - Array.from(ref).length
          const title = room >= 8 ? fit(item.title, room) : ''
          return (
            <Button
              key={`pr-${ref}`}
              plain
              onPress={async () => {
                if (state !== undefined) return
                await markRunning($, [ref])
                // The command queues a model turn that outlasts the press budget, so it is not awaited.
                void $.command.run({ command: config.reviewCommand, args: ref }).catch(err =>
                  $.ui.toast(`Could not start the review of ${ref}: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown error'}`),
                )
              }}
            >
              <Text color={state === 'running' ? 'error' : state === 'done' ? 'success' : 'inactive'}>
                {state === undefined ? '○' : '●'}
              </Text>{' '}
              <Text color="suggestion">{org}</Text>
              <Text dimColor>/</Text>
              <Text color="claude">{repo}</Text>
              <Text color="warning">#{item.number}</Text>
              {title ? ` ${title}` : ''}
            </Button>
          )
        })}
        {visible.length > rows.length ? (
          <Text dimColor>{visible.length - rows.length} more are not shown.</Text>
        ) : null}
      </Box>
    )
  })
}
