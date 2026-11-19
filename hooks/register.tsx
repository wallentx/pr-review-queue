import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Queue, QueueItem, ReviewStatus } from '../types'

const POLL_MS = 5 * 60 * 1000
/** How often a session looks at the shared file for a newer result. */
const TICK_MS = 30 * 1000
/** How long a claim to fetch holds, longer than the 120 s AID.review-queue timeout. */
const CLAIM_MS = 150 * 1000
/** How long a claimer waits before reading its claim back, so a racing claim lands first. */
const CLAIM_SETTLE_MS = 1000
/** How long a shared file may fail to parse before a session writes over it. */
const UNREADABLE_MS = 2 * TICK_MS
const MAX_ROWS = 9
const COMMAND = 'pr-queue'

const isEnabled = atom({ plugin: 'pr-review-queue', key: 'isEnabled' } as const, false)
const isExpanded = atom({ plugin: 'pr-review-queue', key: 'isExpanded' } as const, false)
// Change a tag when its value's fields change, so a stale stored value is dropped.
const queue = atom({ plugin: 'pr-review-queue', key: 'queue' } as const, null, { shape: 'queue-2' })
const statuses = atom({ plugin: 'pr-review-queue', key: 'statuses' } as const, {}, { shape: 'statuses-1' })
const agents = atom({ plugin: 'pr-review-queue', key: 'agents' } as const, {}, { shape: 'agents-1' })
const hiddenAtom = atom({ plugin: 'pr-review-queue', key: 'hidden' } as const, [], { shape: 'hidden-1' })
const revealed = atom({ plugin: 'pr-review-queue', key: 'revealed' } as const, null)
const HIDDEN_KEY = 'hiddenRefs'

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

/** A 32-bit FNV-1a hash in hex, enough to name one cache file per query. */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The file every session running the same query shares. AID.review-queue infers
 * the owner from the working directory when no workspace is set, so that
 * directory is part of the query. The variables gh reads to pick the GitHub
 * account and host are part of it too, so sessions signed in differently never
 * share a result. They reach the file name only through the hash.
 */
async function cachePathOf($: EngineInterface, cwd: string): Promise<string | undefined> {
  const base = (await $.env.get('XDG_CACHE_HOME')) || ((h => (h ? `${h}/.cache` : undefined))(await $.env.get('HOME')))
  if (!base) return undefined
  const identity = [
    await $.env.get('GH_TOKEN'),
    await $.env.get('GITHUB_TOKEN'),
    await $.env.get('GH_HOST'),
    await $.env.get('GH_CONFIG_DIR'),
  ]
  const query = JSON.stringify([queueArgv(config), config.workspace || cwd, identity])
  return `${base}/pr-review-queue/queue-${hashOf(query)}.json`
}

/** What sessions with the same query share: the last result and who is fetching the next one. */
type Shared = { fetchedAt?: number; result?: Queue; claimedBy?: string; claimedAt?: number }

let config: Config = configOf(undefined)
let timer: { cancel: () => void } | undefined
let cachePath: string | undefined
let lastSeen = 0
let isTicking = false
let unreadableSince: number | undefined
const holder = Math.random().toString(36).slice(2)

/** The shared file's content: `{}` when absent, undefined when it does not parse (mid-write, or left truncated). */
async function readShared($: EngineInterface, path: string): Promise<Shared | undefined> {
  try {
    if (!(await $.fs.exists(path))) return {}
    const data = JSON.parse(await $.fs.read(path))
    return data && typeof data === 'object' ? (data as Shared) : {}
  } catch {
    return undefined
  }
}

/**
 * One check of the shared queue. A session uses a result younger than
 * POLL_MS that any session fetched. When the result is older, one session
 * claims the fetch and the rest keep showing the old result until the new
 * one lands. The claim is a write followed by a read-back, so two sessions
 * that claim at the same moment can both fetch once, which costs one extra
 * AID.review-queue run and nothing else.
 */
/** Reads the hidden pull requests from the store, which every session shares. */
async function loadHidden($: EngineInterface): Promise<void> {
  // A store that cannot be read keeps the list this session already has.
  const stored = await $.store.get(HIDDEN_KEY).catch(() => undefined)
  if (stored === undefined) return
  const refs = Array.isArray(stored) ? stored.filter((r): r is string => typeof r === 'string') : []
  await update($, hiddenAtom, all => (all.length === refs.length && all.every((r, i) => r === refs[i]) ? all : refs))
}

async function saveHidden($: EngineInterface, refs: string[]): Promise<void> {
  await $.store.set(HIDDEN_KEY, refs)
  await update($, hiddenAtom, () => refs)
}

async function tick($: EngineInterface): Promise<void> {
  await loadHidden($)
  // A fetch can outlast TICK_MS, and the claim already names this session, so
  // a second check started meanwhile would fetch again.
  if (isTicking) return
  isTicking = true
  try {
    await check($)
  } catch (err) {
    // A cache directory this session cannot write leaves it checking on its own.
    const detail = err instanceof Error ? err.message.slice(0, 80) : 'unknown error'
    cachePath = undefined
    void $.ui.toast(`The PR review queue cannot use its shared cache (${detail}), so this session checks on its own.`)
    await poll($)
  } finally {
    isTicking = false
  }
}

async function check($: EngineInterface): Promise<void> {
  if (!(await read($, isEnabled))) return
  const path = cachePath
  if (path === undefined) return poll($)
  const now = await $.clock.now()
  let shared = await readShared($, path)
  if (shared === undefined) {
    // Another session may be mid-write, so wait a while. A file that still does
    // not parse after that was left truncated, and this session writes over it.
    unreadableSince ??= now
    if (now - unreadableSince < UNREADABLE_MS) return
    shared = {}
  }
  unreadableSince = undefined
  if (shared.result && now - (shared.fetchedAt ?? 0) < POLL_MS) {
    if (shared.fetchedAt !== lastSeen) {
      lastSeen = shared.fetchedAt ?? 0
      await apply($, shared.result)
    }
    return
  }
  if (shared.claimedBy && shared.claimedBy !== holder && now - (shared.claimedAt ?? 0) < CLAIM_MS) return
  await $.fs.write(path, JSON.stringify({ ...shared, claimedBy: holder, claimedAt: now }))
  await $.clock.sleep(CLAIM_SETTLE_MS)
  if ((await readShared($, path))?.claimedBy !== holder) return
  const result = await fetchQueue($)
  const fetchedAt = await $.clock.now()
  await $.fs.write(path, JSON.stringify({ fetchedAt, result } satisfies Shared))
  lastSeen = fetchedAt
  await apply($, result)
}

/**
 * A check with no shared file, used when neither XDG_CACHE_HOME nor HOME is
 * set or the cache cannot be written. It runs at most once per POLL_MS,
 * though the timer fires every TICK_MS.
 */
async function poll($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (lastSeen !== 0 && now - lastSeen < POLL_MS) return
  lastSeen = now
  await apply($, await fetchQueue($))
}

async function fetchQueue($: EngineInterface): Promise<Queue> {
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
  return result
}

/** Shows a result in this session. */
async function apply($: EngineInterface, result: Queue): Promise<void> {
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
  lastSeen = 0
  void tick($)
  timer = $.clock.every(TICK_MS, () => void tick($))
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
      description: 'Turn the PR review queue on or off (on, off, or no argument to toggle); unhide shows hidden pull requests again',
    })
    cachePath = await cachePathOf($, started.cwd)
    // Each session starts off. A hot reload runs this again with the session's
    // state kept, so a queue that was on keeps checking.
    if (await read($, isEnabled)) startPolling($)
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'unhide' || arg.startsWith('unhide ')) {
      const stored = await $.store.get(HIDDEN_KEY)
      const before = Array.isArray(stored) ? stored.filter((r): r is string => typeof r === 'string') : []
      // `unhide owner/repo#N` shows one pull request again; `unhide` alone shows them all.
      const named = new Set(refsIn(e.args).map(r => r.toLowerCase()))
      const after = named.size > 0 ? before.filter(r => !named.has(r.toLowerCase())) : []
      await saveHidden($, after)
      const count = before.length - after.length
      return {
        text:
          count === 0
            ? 'No hidden pull request matched.'
            : `${count} hidden pull request${count === 1 ? ' is' : 's are'} shown again.`,
      }
    }
    const current = await read($, isEnabled)
    const wanted = arg === 'on' ? true : arg === 'off' ? false : !current
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
    const hiddenRefs = new Set(await read($, hiddenAtom))
    const visible = q.items.filter(item => status[refOf(item)] !== 'posted' && !hiddenRefs.has(refOf(item)))
    const hidden = q.items.length - visible.length
    const total = Math.max(0, q.total - hidden)
    if (total === 0) {
      return next(e)
    }

    const expanded = await read($, isExpanded)
    const header = (
      // The whole line is the toggle, so a click anywhere on it shows or hides the list.
      <Button
        key="toggle"
        label={expanded ? 'Hide the list' : 'Show the list'}
        plain
        onPress={() => update($, isExpanded, v => !v)}
      >
        <Text color="warning">
          Reviews waiting: {total}
          {q.isComplete ? '' : ' (partial)'}{' '}
        </Text>
        <Text>{expanded ? '▼' : '▶'}</Text>
      </Button>
    )

    if (!expanded) {
      return header
    }

    const columns = e.props.bodyColumns > 0 ? e.props.bodyColumns : 80
    const rows = visible.slice(0, MAX_ROWS)
    const open = await read($, revealed)
    return (
      <Box flexDirection="column">
        {header}
        {rows.map(item => {
          const ref = refOf(item)
          const state = status[ref]
          const [org, repo] = item.repo.split('/')
          const isOpen = open === ref
          // Marker and spaces take 3 columns, `[x] ` 4 more; one more keeps the row off the last column.
          const room = columns - 4 - (isOpen ? 4 : 0) - Array.from(ref).length
          const title = room >= 8 ? fit(item.title, room) : ''
          return (
            <Box key={`row-${ref}`} flexDirection="row">
              {isOpen ? (
                <Button
                  key={`hide-${ref}`}
                  plain
                  label="x"
                  onPress={async () => {
                    const stored = await $.store.get(HIDDEN_KEY)
                    const before = Array.isArray(stored) ? stored.filter((r): r is string => typeof r === 'string') : []
                    await saveHidden($, before.includes(ref) ? before : [...before, ref])
                    await update($, revealed, () => null)
                  }}
                >
                  <Text color="suggestion">[</Text>
                  <Text color="error">x</Text>
                  <Text color="suggestion">]</Text>{' '}
                </Button>
              ) : null}
              <Button
                key={`dot-${ref}`}
                plain
                label={state === undefined ? '○' : '●'}
                onPress={() => update($, revealed, current => (current === ref ? null : ref))}
              >
                <Text color={state === 'running' ? 'error' : state === 'done' ? 'success' : 'inactive'}>
                  {state === undefined ? '○' : '●'}
                </Text>
              </Button>
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
              {' '}
              <Text color="suggestion">{org}</Text>
              <Text dimColor>/</Text>
              <Text color="claude">{repo}</Text>
              <Text color="warning">#{item.number}</Text>
              {title ? ` ${title}` : ''}
            </Button>
            </Box>
          )
        })}
        {visible.length > rows.length ? (
          <Text dimColor>{visible.length - rows.length} more are not shown.</Text>
        ) : null}
      </Box>
    )
  })
}
