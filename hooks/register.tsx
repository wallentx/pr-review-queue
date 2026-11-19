import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Choice, Queue, QueueItem, ReviewStatus } from '../types'

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
const statuses = atom({ plugin: 'pr-review-queue', key: 'statuses' } as const, {}, { shape: 'statuses-2' })
const agents = atom({ plugin: 'pr-review-queue', key: 'agents' } as const, {}, { shape: 'agents-1' })
const activity = atom({ plugin: 'pr-review-queue', key: 'activity' } as const, {}, { shape: 'activity-1' })
const commandTurns = atom({ plugin: 'pr-review-queue', key: 'commandTurns' } as const, {}, { shape: 'turns-1' })
const frame = atom({ plugin: 'pr-review-queue', key: 'frame' } as const, 0)

/** How often a running review's dot changes color. */
const PULSE_MS = 250
/** How many pulse frames pass between checks of the agent list. */
const RECONCILE_FRAMES = 8
/** Yellow to blue while the model reads its input or a tool runs: tokens in. */
const IN_COLORS = ['#e5c07b', '#c9bb93', '#a5b6b3', '#82b2d3', '#61afef', '#82b2d3', '#a5b6b3', '#c9bb93']
/** Yellow to red while the model writes: tokens out. */
const OUT_COLORS = ['#e5c07b', '#e4b17a', '#e3a079', '#e18e77', '#e06c75', '#e18e77', '#e3a079', '#e4b17a']
const hiddenAtom = atom({ plugin: 'pr-review-queue', key: 'hidden' } as const, [], { shape: 'hidden-1' })
const isEditing = atom({ plugin: 'pr-review-queue', key: 'isEditing' } as const, false)
const isShowingHidden = atom({ plugin: 'pr-review-queue', key: 'isShowingHidden' } as const, false)
const HIDDEN_KEY = 'hiddenRefs'
/**
 * The glyph that lists hidden pull requests and restores one. Each control
 * glyph is followed by a Text holding one plain space, outside its button,
 * since a terminal shrinks a glyph whose next cell is not a plain space.
 */
const RESTORE = '⟲'
/**
 * Keeps a button's colors while the pointer is over its row, where the
 * terminal would otherwise invert it. Hover overrides need a keyed Box around
 * the button, so the header and every row are keyed.
 */
const NO_HOVER = { inverse: false } as const

const choicesAtom = atom({ plugin: 'pr-review-queue', key: 'choices' } as const, {}, { shape: 'choices-2' })
const OFFER_TOOL = 'offer_choices'
/** The brackets around each choice button. */
const BRACKET_COLOR = '#87cefa'
/** The most buttons one pull request shows. */
const MAX_CHOICES = 5
/**
 * The glyphs a choice button can show, each with the meaning it usually
 * carries. The agent picks the glyphs that fit what it is asking and writes
 * what each button does, so a meaning here is a convention, not a rule. A glyph
 * marked wide is drawn by most fonts across two cells while the terminal gives
 * it one, so a plain space follows it for the glyph to spill into.
 */
const PALETTE: Record<string, { color?: string; isWide?: boolean; means: string }> = {
  '✓': { color: 'success', means: 'approve' },
  '🗩': { isWide: true, means: 'comment' },
  '🗈': { isWide: true, means: 'suggested changes' },
  '⊘': { color: 'error', means: 'request changes' },
}
const MAX_GLYPHS = 2

/** A button's glyphs, read from what the agent passed; undefined when any is outside the palette. */
function glyphsOf(text: string): string[] | undefined {
  // Variation selectors ask for text or emoji presentation and are not glyphs of their own.
  const glyphs = Array.from(text.replace(/[\uFE0E\uFE0F\s]/g, ''))
  return glyphs.length > 0 && glyphs.length <= MAX_GLYPHS && glyphs.every(g => g in PALETTE) ? glyphs : undefined
}

/** The columns one choice button takes: its brackets, its glyphs, and the space after a wide one. */
function widthOf(choice: Choice): number {
  return 2 + (glyphsOf(choice.glyph) ?? []).reduce((n, g) => n + (PALETTE[g]!.isWide ? 2 : 1), 0)
}

/** Drops one pull request's choice buttons. */
async function clearChoices($: EngineInterface, refs: readonly string[]): Promise<void> {
  await update($, choicesAtom, all =>
    refs.some(ref => ref in all) ? Object.fromEntries(Object.entries(all).filter(([ref]) => !refs.includes(ref))) : all,
  )
}

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

const API_REVIEW_RE = /repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pulls\/(\d+)\/reviews(?![\/\w])/

/**
 * The refs a shell command posted a review to: `gh pr review N --repo
 * owner/repo` with `--approve`, `--request-changes` or `--comment`, or a `gh
 * api` POST to `repos/owner/repo/pulls/N/reviews`, the way a review with inline
 * comments is posted. A `gh api` call sends a POST when it names the method or
 * carries a field or an input file.
 */
function postedRefs(command: string): string[] {
  const refs: string[] = []
  for (const part of command.split(/&&|\|\||;|\n/)) {
    if (/\bgh\s+pr\s+review\b/.test(part) && /--(approve|request-changes|comment)\b|\s-[arc]\b/.test(part)) {
      const repo = part.match(/(?:--repo|-R)[\s=]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1]
      const number = part.match(/\bgh\s+pr\s+review\s+(?:-\S+\s+\S+\s+)*?(\d+)\b/)?.[1]
      if (repo && number) refs.push(`${repo}#${number}`)
      continue
    }
    const api = /\bgh\s+api\b/.test(part) ? part.match(API_REVIEW_RE) : null
    const isPost =
      /(?:-X|--method)[\s=]+['"]?POST\b/i.test(part) ||
      (!/(?:-X|--method)[\s=]+['"]?(?:GET|PUT|PATCH|DELETE)\b/i.test(part) && /\s(?:-f|-F|--field|--raw-field|--input)[\s=]/.test(part))
    if (api && isPost) refs.push(`${api[1]}#${api[2]}`)
  }
  return refs
}

/** Cuts text to at most `width` characters, ending in an ellipsis when cut. */
function fit(text: string, width: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (width <= 0) return ''
  return chars.length <= width ? chars.join('') : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

/** The dot's color: its status, and for a running review what its subagent is doing. */
function markerColor(state: ReviewStatus | undefined, doing: Activity | undefined, tick: number): string {
  switch (state) {
    case 'starting':
      return 'warning'
    case 'running':
      return (doing === 'out' ? OUT_COLORS : IN_COLORS)[tick % IN_COLORS.length]!
    case 'done':
      return 'success'
    case 'failed':
      return 'error'
    case 'posted':
      return 'suggestion'
    default:
      return 'inactive'
  }
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
let pulse: { cancel: () => void } | undefined
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

/** Hides or restores one pull request in every session. */
async function setHidden($: EngineInterface, ref: string, isHidden: boolean): Promise<void> {
  const stored = await $.store.get(HIDDEN_KEY)
  const before = Array.isArray(stored) ? stored.filter((r): r is string => typeof r === 'string') : []
  const rest = before.filter(r => r !== ref)
  await saveHidden($, isHidden ? [...rest, ref] : rest)
}

async function tick($: EngineInterface): Promise<void> {
  await loadHidden($)
  await reconcile($)
  await syncPulse($)
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
    await update($, choicesAtom, all =>
      Object.keys(all).every(ref => listed.has(ref))
        ? all
        : Object.fromEntries(Object.entries(all).filter(([ref]) => listed.has(ref))),
    )
    // A hidden pull request that no longer waits on a review (reviewed, merged,
    // closed) is forgotten. Only a complete list proves it is gone.
    if (result.isComplete) {
      const kept = (await read($, hiddenAtom)).filter(ref => listed.has(ref))
      if (kept.length !== (await read($, hiddenAtom)).length) await saveHidden($, kept)
    }
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

/** Marks PRs whose review command just ran: yellow until a subagent picks them up. */
async function markStarting($: EngineInterface, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return
  await clearChoices($, refs)
  await update($, statuses, all => {
    const marked: Record<string, ReviewStatus> = { ...all }
    for (const ref of refs) marked[ref] = 'starting'
    return marked
  })
  await update($, commandTurns, all => Object.fromEntries(Object.entries(all).filter(([ref]) => !refs.includes(ref))))
}

async function setActivity($: EngineInterface, ref: string, doing: Activity): Promise<void> {
  await update($, activity, (all): Record<string, Activity> => (all[ref] === doing ? all : { ...all, [ref]: doing }))
}

/** Sets one PR's status, or clears it (gray) with undefined. */
async function setStatus($: EngineInterface, ref: string, status: ReviewStatus | undefined): Promise<void> {
  await update($, statuses, all => {
    const { [ref]: _, ...rest } = all
    return status === undefined ? rest : { ...rest, [ref]: status }
  })
}

/** Ends a reviewer's tracking and sets its PR's status from how the subagent ended. */
async function endReviewer($: EngineInterface, agentId: string, status: ReviewStatus | undefined): Promise<void> {
  const ref = (await read($, agents))[agentId]
  if (ref === undefined) return
  await update($, agents, all => Object.fromEntries(Object.entries(all).filter(([id]) => id !== agentId)))
  await update($, activity, all => Object.fromEntries(Object.entries(all).filter(([r]) => r !== ref)))
  if ((await read($, statuses))[ref] === 'running') await setStatus($, ref, status)
}

/**
 * Settles reviewers whose end no event reported, from the engine's agent list:
 * a finished one turns green, a failed one red, and a stopped or vanished one
 * gray, so it can be picked again.
 */
async function reconcile($: EngineInterface): Promise<void> {
  const tracked = Object.keys(await read($, agents))
  if (tracked.length === 0) return
  const list = await $.agent.list().catch(() => undefined)
  if (list === undefined) return
  for (const id of tracked) {
    const info = list.find(agent => agent.id === id)
    if (info === undefined || info.status === 'killed') await endReviewer($, id, undefined)
    else if (info.status === 'completed') await endReviewer($, id, 'done')
    else if (info.status === 'failed') await endReviewer($, id, 'failed')
  }
}

/** Runs the pulse while any review is running, and stops it when none is. */
async function syncPulse($: EngineInterface): Promise<void> {
  const isRunning = Object.values(await read($, statuses)).includes('running')
  if (isRunning && pulse === undefined) {
    let count = 0
    pulse = $.clock.every(PULSE_MS, () => {
      count++
      void update($, frame, n => (n + 1) % IN_COLORS.length)
      if (count % RECONCILE_FRAMES === 0) void reconcile($).then(() => syncPulse($))
    })
  } else if (!isRunning && pulse !== undefined) {
    pulse.cancel()
    pulse = undefined
  }
}

export const register: Register = (on, options) => {
  config = configOf(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Turn the PR review queue on or off (on, off, or no argument to toggle); unhide shows hidden pull requests again',
    })
    await $.tool.register({
      name: OFFER_TOOL,
      description: [
        'Shows buttons on a pull request in the PR review queue for the next steps you are asking the person to choose between, such as after you draft a review and before you post anything.',
        `Each button shows one or two glyphs from this palette. The meanings are the usual ones; pick the glyphs that best fit each step, and combine two when a step does both (for example ✓🗩 for approving with comments):`,
        ...Object.entries(PALETTE).map(([g, p]) => `${g}: ${p.means}`),
        `Give each button an action: the instruction a press sends you as the person's own message, naming the pull request, such as "Approve owner/repo#N and post the drafted nits as comments." Offer at most ${MAX_CHOICES} buttons, recommended first.`,
        'After calling this tool, end your reply with one sentence that names your recommended button by its glyph, such as "If you want me to approve the pull request, select ✓, or tell me what to do otherwise." Never ask the person to type a trigger word.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The pull request, as owner/repo#N.' },
          choices: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_CHOICES,
            items: {
              type: 'object',
              properties: {
                glyph: { type: 'string', description: `One or two glyphs from: ${Object.keys(PALETTE).join(' ')}` },
                action: { type: 'string', description: "What a press asks you to do, in the person's words." },
              },
              required: ['glyph', 'action'],
            },
          },
        },
        required: ['ref', 'choices'],
      },
      isDeferred: false,
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

  // A review started from the queue or typed by hand marks its PRs yellow.
  on('command.run', async ($, e, next) => {
    if (e.command === config.reviewCommand) await markStarting($, refsIn(e.args))
    return next(e)
  })

  // The main turn that runs the review command names its PR in its prompt.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started
    const starting = Object.entries(await read($, statuses))
      .filter(([, status]) => status === 'starting')
      .map(([ref]) => ref)
    const named = new Set(refsIn(e.text))
    const bound = new Set(Object.keys(await read($, commandTurns)))
    const refs = starting.filter(ref => named.has(ref) && !bound.has(ref))
    if (refs.length > 0) {
      await update($, commandTurns, all => ({ ...all, ...Object.fromEntries(refs.map(ref => [ref, e.turnId])) }))
    }
    return started
  })

  // A subagent whose prompt names a starting PR is that PR's reviewer.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!started.agentId) return started
    const status = await read($, statuses)
    const named = new Set(refsIn(e.prompt))
    const ref = Object.keys(status).find(r => named.has(r) && status[r] === 'starting')
    if (ref) {
      const id = started.agentId
      await update($, agents, all => ({ ...all, [id]: ref }))
      await setActivity($, ref, 'in')
      await setStatus($, ref, 'running')
      await syncPulse($)
    }
    return started
  })

  // A reviewer's step: the model reads its input until the first piece arrives, then writes.
  on('turn.step', async function* ($, e, next) {
    const ref = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
    if (ref === undefined) return yield* next(e)
    await setActivity($, ref, 'in')
    let isWriting = false
    const stream = next(e)
    for await (const chunk of stream) {
      if (!isWriting && chunk.kind !== 'engine') {
        isWriting = true
        await setActivity($, ref, 'out')
      }
      yield chunk
    }
    return await stream.result
  })

  // How a turn ended settles the PR it was reviewing.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? undefined : 'failed'
    if (id !== undefined) {
      await endReviewer($, id, status)
    } else {
      // The command's own turn ended before any subagent took the review: it was
      // stopped, it failed, or the model reviewed in the main conversation.
      const turns = await read($, commandTurns)
      const refs = Object.keys(turns).filter(ref => turns[ref] === e.turnId)
      for (const ref of refs) {
        if ((await read($, statuses))[ref] === 'starting') await setStatus($, ref, status)
      }
      if (refs.length > 0) {
        await update($, commandTurns, all => Object.fromEntries(Object.entries(all).filter(([ref]) => !refs.includes(ref))))
      }
    }
    await syncPulse($)
    return next(e)
  })

  // A reviewer running a tool waits on input, so its dot pulses blue.
  on('tool.call', async ($, e, next) => {
    const ref = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
    if (ref !== undefined) await setActivity($, ref, 'in')
    return next(e)
  })

  // A successful `gh pr review` marks the PR posted; it stays listed until the queue drops it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || ran.deny !== undefined) return ran
    const refs = postedRefs(e.command)
    for (const ref of refs) await setStatus($, ref, 'posted')
    // A posted review has been decided, so its choice buttons go away.
    await clearChoices($, refs)
    return ran
  })

  // The agent offers the next steps for a review it drafted, as buttons on the pull request's row.
  on('tool.call', { tool: `mcp__pr-review-queue__${OFFER_TOOL}` }, async ($, e) => {
    const input = e as unknown as { ref?: unknown; choices?: unknown }
    const ref = typeof input.ref === 'string' ? refsIn(input.ref)[0] : undefined
    const raw = Array.isArray(input.choices) ? (input.choices as { glyph?: unknown; action?: unknown }[]) : []
    const choices: Choice[] = []
    for (const c of raw.slice(0, MAX_CHOICES)) {
      const glyphs = typeof c?.glyph === 'string' ? glyphsOf(c.glyph) : undefined
      const action = typeof c?.action === 'string' ? c.action.trim() : ''
      if (glyphs === undefined || action === '') {
        return { deny: `Each choice needs an action and one or two glyphs from ${Object.keys(PALETTE).join(' ')}; ${JSON.stringify(c?.glyph)} is not one.` }
      }
      choices.push({ glyph: glyphs.join(''), action })
    }
    if (ref === undefined || choices.length === 0) {
      return { deny: 'Pass ref as owner/repo#N and at least one choice.' }
    }
    await update($, choicesAtom, all => ({ ...all, [ref]: choices }))
    const q = await read($, queue)
    const isShown = (await read($, isEnabled)) && q?.kind === 'ok' && q.items.some(item => refOf(item) === ref)
    return {
      result: isShown
        ? `The queue shows ${choices.map(c => c.glyph).join(' ')} on ${ref}. End your reply with one sentence naming your recommended button by its glyph.`
        : `The PR review queue is not showing ${ref}, so the buttons are not visible. Ask the person in words which step to take.`,
    }
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
    const visible = q.items.filter(item => !hiddenRefs.has(refOf(item)))
    const hiddenItems = q.items.filter(item => hiddenRefs.has(refOf(item)))
    // A posted review stays on its line with a check mark but no longer counts as waiting.
    const posted = visible.filter(item => status[refOf(item)] === 'posted').length
    const total = Math.max(0, q.total - hiddenItems.length - posted)
    const tick = await read($, frame)
    const doing = await read($, activity)
    // A queue whose every pull request is hidden still draws its line, so the
    // hidden ones can be brought back.
    if (total === 0 && hiddenItems.length === 0) {
      return next(e)
    }

    const expanded = await read($, isExpanded)
    const editing = await read($, isEditing)
    const showingHidden = editing && hiddenItems.length > 0 && (await read($, isShowingHidden))

    const header = (
      <Box key="header" flexDirection="row">
        <Button
          key="edit"
          label={editing ? 'Stop editing the list' : 'Edit the list'}
          plain
          hover={NO_HOVER}
          onPress={async () => {
            if (editing) {
              await update($, isEditing, () => false)
              await update($, isShowingHidden, () => false)
              return
            }
            await update($, isEditing, () => true)
            await update($, isExpanded, () => true)
          }}
        >
          <Text>{editing ? '◨' : '◧'}</Text>
        </Button>
        <Text key="edit-gap"> </Text>
        {editing && hiddenItems.length > 0 ? (
          <Button
            key="show-hidden"
            label={showingHidden ? 'Stop showing hidden pull requests' : 'Show hidden pull requests'}
            plain
            hover={NO_HOVER}
            onPress={() => update($, isShowingHidden, v => !v)}
          >
            <Text color="success" bold>{RESTORE}</Text>
          </Button>
        ) : null}
        {editing && hiddenItems.length > 0 ? <Text key="show-hidden-gap"> </Text> : null}
        {/* The rest of the line is the toggle, so a click anywhere on it shows or hides the list. */}
        <Button
          key="toggle"
          label={expanded ? 'Hide the list' : 'Show the list'}
          plain
          hover={NO_HOVER}
          onPress={async () => {
            // Collapsing the list also leaves editing, since its controls are on the rows.
            if (expanded) {
              await update($, isEditing, () => false)
              await update($, isShowingHidden, () => false)
            }
            await update($, isExpanded, v => !v)
          }}
        >
          <Text color="warning">
            Reviews waiting: {total}
            {q.isComplete ? '' : ' (partial)'}{' '}
          </Text>
          <Text>{expanded ? '▼' : '▶'}</Text>
        </Button>
      </Box>
    )

    if (!expanded) {
      return header
    }

    const columns = e.props.bodyColumns > 0 ? e.props.bodyColumns : 80
    const rows = visible.slice(0, MAX_ROWS)
    const hiddenRows = showingHidden ? hiddenItems.slice(0, Math.max(0, MAX_ROWS - rows.length)) : []
    const notShown = visible.length - rows.length + (showingHidden ? hiddenItems.length - hiddenRows.length : 0)

    const offered = await read($, choicesAtom)

    /** The title cut to the room a row leaves after its marker, its ref, and `used` more columns. */
    const titleOf = (item: QueueItem, used: number) => {
      // Marker and spaces take 3 columns, the edit control 2 more; one more keeps the row off the last column.
      const room = columns - 4 - (editing ? 2 : 0) - Array.from(refOf(item)).length - used
      return room >= 8 ? fit(item.title, room) : ''
    }

    /** A row's text: marker, `owner/repo#N` in fixed colors, and the title when `title` is given. */
    const body = (item: QueueItem, isHidden: boolean, title: string) => {
      const ref = refOf(item)
      const state = status[ref]
      const [org, repo] = item.repo.split('/')
      // A hidden row is struck through and dim in every part.
      const strike = isHidden ? { strikethrough: true, dimColor: true } : {}
      // An array, since a Button holds strings and Text only, never a fragment's Box.
      return [
        <Text key="marker" {...strike} color={markerColor(state, doing[ref], tick)}>
          {state === undefined || state === 'starting' ? '○' : state === 'posted' ? '✓' : '●'}
        </Text>,
        <Text key="gap" {...strike}> </Text>,
        <Text key="org" {...strike} color="suggestion">{org}</Text>,
        <Text key="slash" {...strike} dimColor>/</Text>,
        <Text key="repo" {...strike} color="claude">{repo}</Text>,
        <Text key="number" {...strike} color="warning">#{item.number}</Text>,
        title ? <Text key="title" {...strike}> {title}</Text> : null,
      ]
    }

    return (
      <Box flexDirection="column">
        {header}
        {rows.map(item => {
          const ref = refOf(item)
          const state = status[ref]
          const choices = offered[ref] ?? []
          // Each button is followed by the space before the next part.
          const used = choices.reduce((n, c) => n + widthOf(c) + 1, 0)
          const title = titleOf(item, used)
          return (
            <Box key={`row-${ref}`} flexDirection="row">
              {editing ? (
                <Button key={`hide-${ref}`} label={`Hide ${ref}`} plain hover={NO_HOVER} onPress={() => setHidden($, ref, true)}>
                  <Text color="error">⨯</Text>
                </Button>
              ) : null}
              {editing ? <Text key="hide-gap"> </Text> : null}
              <Button
                key={`pr-${ref}`}
                plain
                hover={NO_HOVER}
                onPress={async () => {
                  // Only a waiting or failed review starts again.
                  if (state !== undefined && state !== 'failed') return
                  await markStarting($, [ref])
                  // The command queues a model turn that outlasts the press budget, so it is not awaited.
                  void $.command.run({ command: config.reviewCommand, args: ref }).catch(err =>
                    $.ui.toast(`Could not start the review of ${ref}: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown error'}`),
                  )
                }}
              >
                {body(item, false, choices.length > 0 ? '' : title)}
              </Button>
              {choices.flatMap(choice => [
                <Text key={`choice-gap-${choice.glyph}`}> </Text>,
                <Button
                  key={`choice-${choice.glyph}-${ref}`}
                  label={choice.action}
                  plain
                  hover={NO_HOVER}
                  onPress={async () => {
                    await clearChoices($, [ref])
                    // The prompt starts a model turn that outlasts the press budget, so it is not awaited.
                    void $.prompt
                      .submit({ text: `${choice.glyph} ${choice.action}`, asUser: true })
                      .catch(err =>
                        $.ui.toast(`Could not send ${choice.glyph} for ${ref}: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown error'}`),
                      )
                  }}
                >
                  {[
                    <Text key="open" color={BRACKET_COLOR}>[</Text>,
                    ...(glyphsOf(choice.glyph) ?? []).flatMap((glyph, i) => [
                      <Text key={`glyph-${i}`} color={PALETTE[glyph]!.color}>{glyph}</Text>,
                      PALETTE[glyph]!.isWide ? <Text key={`spill-${i}`}> </Text> : null,
                    ]),
                    <Text key="close" color={BRACKET_COLOR}>]</Text>,
                  ]}
                </Button>,
              ])}
              {choices.length > 0 && title ? <Text key="title"> {title}</Text> : null}
            </Box>
          )
        })}
        {hiddenRows.map(item => {
          const ref = refOf(item)
          return (
            <Box key={`hidden-row-${ref}`} flexDirection="row">
              <Button key={`restore-${ref}`} label={`Restore ${ref}`} plain hover={NO_HOVER} onPress={() => setHidden($, ref, false)}>
                <Text color="success" bold>{RESTORE}</Text>
              </Button>
              <Text key="restore-gap"> </Text>
              {body(item, true, titleOf(item, 0))}
            </Box>
          )
        })}
        {notShown > 0 ? <Text dimColor>{notShown} more are not shown.</Text> : null}
      </Box>
    )
  })
}
