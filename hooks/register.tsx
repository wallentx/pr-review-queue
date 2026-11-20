import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Choice, HiddenEntry, Queue, QueueItem, ReviewStatus } from '../types'

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

/** Frame interval shared by hover highlights and running review markers. */
const PULSE_MS = 250
/** How many pulse frames pass between checks of the agent list. */
const RECONCILE_FRAMES = 8
/** Yellow to blue while the model reads its input or a tool runs: tokens in. */
const IN_COLORS = ['#e5c07b', '#c9bb93', '#a5b6b3', '#82b2d3', '#61afef', '#82b2d3', '#a5b6b3', '#c9bb93']
/** Yellow to red while the model writes: tokens out. */
const OUT_COLORS = ['#e5c07b', '#e4b17a', '#e3a079', '#e18e77', '#e06c75', '#e18e77', '#e3a079', '#e4b17a']
const hiddenAtom = atom({ plugin: 'pr-review-queue', key: 'hidden' } as const, [], { shape: 'hidden-2' })
const hiddenAtEditStart = atom({ plugin: 'pr-review-queue', key: 'hiddenAtEditStart' } as const, null, { shape: 'edit-1' })
const HIDDEN_KEY = 'hiddenRefs'
const EYE = ''
const EYE_CLOSED = ''
const choicesAtom = atom({ plugin: 'pr-review-queue', key: 'choices' } as const, {}, { shape: 'choices-2' })
const OFFER_TOOL = 'offer_choices'
/** The brackets around each choice button. */
const BRACKET_COLOR = '#87cefa'

/** Fraction of the background mixed into the foreground over one two-second cycle. */
const HOVER_FADE = [0.28, 0.24, 0.14, 0.04, 0, 0.04, 0.14, 0.24]
const HOVER_TONES: Record<string, [number, number]> = {
  // Claude Code's dark and light foregrounds for the Text colors this queue draws.
  text: [0xffffff, 0x000000],
  inactive: [0x999999, 0x666666],
  warning: [0xffc107, 0x966c1e],
  suggestion: [0xb1b9f9, 0x5769f7],
  claude: [0xd77757, 0xd77757],
  success: [0x4eba65, 0x2c7a39],
  error: [0xff6b80, 0xab2b3f],
  [BRACKET_COLOR]: [0x87cefa, 0x87cefa],
}

function hoverPalette(theme: unknown): Record<string, string[]> | null {
  // Other themes supply their own colors, including the ANSI and colorblind palettes.
  if (theme !== undefined && theme !== 'dark' && theme !== 'light') return null
  const light = theme === 'light'
  const background = light ? 255 : 0
  return Object.fromEntries(Object.entries(HOVER_TONES).map(([tone, pair]) => {
    const rgb = pair[light ? 1 : 0]
    const channels = [rgb >>> 16, (rgb >>> 8) & 255, rgb & 255]
    const ramp = HOVER_FADE.map(fade => '#' + channels.map(channel =>
      Math.round(channel + (background - channel) * fade).toString(16).padStart(2, '0'),
    ).join(''))
    return [tone, ramp]
  }))
}
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

/** Keep rows in queue order, including previously hidden PRs that need a slot for restoring. */
function layoutOf(items: QueueItem[], hiddenRefs: ReadonlySet<string>, hiddenOnOpen: readonly string[] | null) {
  const visible = items.filter(item => !hiddenRefs.has(refOf(item)))
  const eligible = hiddenOnOpen === null ? visible : items
  let rows = eligible.slice(0, MAX_ROWS)
  if (eligible.length > MAX_ROWS && hiddenOnOpen?.length) {
    // Use the opening selection so toggling an eye never moves its row under the pointer.
    const priority = new Set(hiddenOnOpen)
    const selected = new Set(eligible.filter(item => priority.has(refOf(item))).slice(0, MAX_ROWS))
    for (const item of eligible) {
      if (selected.size === MAX_ROWS) break
      selected.add(item)
    }
    rows = eligible.filter(item => selected.has(item))
  }
  return { visible, rows, notShown: eligible.length - rows.length }
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
async function queryKeyOf($: EngineInterface, cwd: string): Promise<string> {
  const identity = [
    await $.env.get('GH_TOKEN'),
    await $.env.get('GITHUB_TOKEN'),
    await $.env.get('GH_HOST'),
    await $.env.get('GH_CONFIG_DIR'),
  ]
  return hashOf(JSON.stringify([queueArgv(config), config.workspace || cwd, identity]))
}

/** The shared result's file for a query, or undefined when neither XDG_CACHE_HOME nor HOME is set. */
async function cachePathOf($: EngineInterface, key: string): Promise<string | undefined> {
  const base = (await $.env.get('XDG_CACHE_HOME')) || ((h => (h ? `${h}/.cache` : undefined))(await $.env.get('HOME')))
  return base ? `${base}/pr-review-queue/queue-${key}.json` : undefined
}

/** What sessions with the same query share: the last result and who is fetching the next one. */
type Shared = { fetchedAt?: number; result?: Queue; claimedBy?: string; claimedAt?: number }

let config: Config = configOf(undefined)
let timer: { cancel: () => void } | undefined
let cachePath: string | undefined
/** This session's query, by the hash its cache file is named with. */
let queryKey = ''
let lastSeen = 0
let isTicking = false
let pulse: { cancel: () => void } | undefined
let reconcileOnPulse = false
let hoverColors: ReturnType<typeof hoverPalette> | undefined
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
/**
 * The hidden list as stored. An entry from before queries were recorded is a
 * bare ref, read with an empty query so any session's complete check may
 * forget it, as every session could before.
 */
function entriesOf(stored: unknown): HiddenEntry[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((entry: any): HiddenEntry[] =>
    typeof entry === 'string'
      ? [{ ref: entry, query: '' }]
      : typeof entry?.ref === 'string' && typeof entry?.query === 'string'
        ? [{ ref: entry.ref, query: entry.query }]
        : [],
  )
}

/** Reads the hidden pull requests from the store, which every session shares. */
async function loadHidden($: EngineInterface): Promise<void> {
  // A store that cannot be read keeps the list this session already has.
  const stored = await $.store.get(HIDDEN_KEY).catch(() => undefined)
  if (stored === undefined) return
  const entries = entriesOf(stored)
  await update($, hiddenAtom, all => (JSON.stringify(all) === JSON.stringify(entries) ? all : entries))
}

async function saveHidden($: EngineInterface, entries: HiddenEntry[]): Promise<void> {
  await $.store.set(HIDDEN_KEY, entries)
  await update($, hiddenAtom, () => entries)
}

/**
 * Hides or restores one pull request in every session. Hiding records this
 * session's query beside the ref, so only a check of that query forgets it.
 * Restoring drops the ref for every query.
 */
async function setHidden($: EngineInterface, ref: string, isHidden: boolean): Promise<void> {
  const before = entriesOf(await $.store.get(HIDDEN_KEY))
  if (!isHidden) return saveHidden($, before.filter(entry => entry.ref !== ref))
  const rest = before.filter(entry => entry.ref !== ref || entry.query !== queryKey)
  await saveHidden($, [...rest, { ref, query: queryKey }])
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
    // closed) is forgotten. Only a complete list proves it is gone, and only
    // for the query that ran: another session's query lists other pull requests.
    if (result.isComplete) {
      const stored = await $.store.get(HIDDEN_KEY).catch(() => undefined)
      const before = stored === undefined ? await read($, hiddenAtom) : entriesOf(stored)
      const kept = before.filter(entry => (entry.query !== queryKey && entry.query !== '') || listed.has(entry.ref))
      if (kept.length !== before.length) await saveHidden($, kept)
    }
  }
  await syncPulse($)
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
  await update($, hiddenAtEditStart, () => null)
  await syncPulse($)
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

/** A single clock drives hover styles whenever the queue has controls, and tracks running reviews. */
async function syncPulse($: EngineInterface): Promise<void> {
  const isRunning = Object.values(await read($, statuses)).includes('running')
  const q = await read($, queue)
  const hasControls = q?.kind === 'ok' && (q.total > 0 || q.items.length > 0)
  const needed = isRunning || hasControls
  reconcileOnPulse = isRunning
  if (needed && pulse === undefined) {
    let count = 0
    pulse = $.clock.every(PULSE_MS, () => {
      count++
      void update($, frame, n => n + 1)
      if (reconcileOnPulse && count % RECONCILE_FRAMES === 0) void reconcile($).then(() => syncPulse($))
    })
  } else if (!needed && pulse !== undefined) {
    pulse.cancel()
    pulse = undefined
  }
}

export const register: Register = (on, options) => {
  config = configOf(options as Record<string, unknown> | undefined)

  on('config.set', { key: 'theme' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value !== undefined) hoverColors = hoverPalette(result.value)
    return result
  })

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
    queryKey = await queryKeyOf($, started.cwd)
    cachePath = await cachePathOf($, queryKey)
    // Each session starts off. A hot reload runs this again with the session's
    // state kept, so a queue that was on keeps checking.
    if (await read($, isEnabled)) startPolling($)
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'unhide' || arg.startsWith('unhide ')) {
      const before = entriesOf(await $.store.get(HIDDEN_KEY))
      // `unhide owner/repo#N` shows one pull request again; `unhide` alone shows them all.
      const named = new Set(refsIn(e.args).map(r => r.toLowerCase()))
      const after = named.size > 0 ? before.filter(entry => !named.has(entry.ref.toLowerCase())) : []
      await saveHidden($, after)
      // Two queries can hide the same pull request, so pull requests are counted, not entries.
      const count = new Set(before.map(entry => entry.ref)).size - new Set(after.map(entry => entry.ref)).size
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
    // Buttons show only on a waiting row the list draws, so a hidden pull
    // request or one past the row limit gets the words-only answer.
    const q = await read($, queue)
    const hiddenRefs = new Set((await read($, hiddenAtom)).map(entry => entry.ref))
    const isShown =
      !hiddenRefs.has(ref) &&
      (await read($, isEnabled)) &&
      q?.kind === 'ok' &&
      layoutOf(q.items, hiddenRefs, await read($, hiddenAtEditStart)).rows.some(item => refOf(item) === ref)
    // A collapsed list draws no rows, so offering buttons opens it.
    if (isShown) await update($, isExpanded, () => true)
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
    const hiddenRefs = new Set((await read($, hiddenAtom)).map(entry => entry.ref))
    const hiddenOnOpen = await read($, hiddenAtEditStart)
    const editing = hiddenOnOpen !== null
    const { visible, rows, notShown } = layoutOf(q.items, hiddenRefs, hiddenOnOpen)
    // A posted review stays on its line with a check mark but no longer counts as waiting.
    const posted = visible.filter(item => status[refOf(item)] === 'posted').length
    const hiddenCount = q.items.length - visible.length
    const total = Math.max(0, q.total - hiddenCount - posted)
    const tick = await read($, frame)
    const doing = await read($, activity)
    // A queue whose every pull request is hidden still draws its line, so the
    // hidden ones can be brought back, and so does one whose every pull request
    // was posted, so the checks stay until a later check drops them.
    if (total === 0 && q.items.length === 0) {
      return next(e)
    }

    const expanded = await read($, isExpanded)
    if (hoverColors === undefined) {
      const settings = await $.config.list().catch(() => [])
      hoverColors = hoverPalette(settings.find(setting => setting.key === 'theme')?.value)
    }
    const palette = hoverColors
    const phase = tick % HOVER_FADE.length
    // A short scope names one hit target, even when its label contains several colored Text runs.
    const hover = (scope: string, tone = 'text') => palette
      ? { scope, inverse: false, dimColor: false, color: (palette[tone] ?? palette.text!)[phase]! }
      : { scope, inverse: false, color: tone, dimColor: HOVER_FADE[phase]! >= 0.14 }
    const editHover = hover('edit')
    const listHover = hover('list')

    const header = (
      <Box key="header" flexDirection="row">
        <Button
          key="edit"
          label={editing ? 'Hide PR visibility controls' : 'Show PR visibility controls'}
          plain
          hover={editHover}
          onPress={async () => {
            await update($, hiddenAtEditStart, () => editing ? null : [...hiddenRefs])
            if (!editing) await update($, isExpanded, () => true)
          }}
        >
          <Text bold hover={editHover}>{editing ? '' : ''}</Text>
        </Button>
        <Text key="edit-gap"> </Text>
        {/* The rest of the line is the toggle, so a click anywhere on it shows or hides the list. */}
        <Button
          key="toggle"
          label={expanded ? 'Hide the list' : 'Show the list'}
          plain
          hover={listHover}
          onPress={async () => {
            // Collapsing the list also leaves editing, since its controls are on the rows.
            if (expanded) await update($, hiddenAtEditStart, () => null)
            await update($, isExpanded, v => !v)
          }}
        >
          <Text color="warning" hover={hover('list', 'warning')}>
            Reviews waiting: {total}
            {q.isComplete ? '' : ' (partial)'}{' '}
          </Text>
          <Text hover={listHover}>{expanded ? '▼' : '▶'}</Text>
        </Button>
      </Box>
    )

    if (!expanded) {
      return header
    }

    const columns = e.props.bodyColumns > 0 ? e.props.bodyColumns : 80

    const offered = await read($, choicesAtom)

    /** The title cut to the room a row leaves after its marker, its ref, and `used` more columns. */
    const titleOf = (item: QueueItem, used: number) => {
      // Marker and spaces take 3 columns, the edit control 2 more; one more keeps the row off the last column.
      const room = columns - 4 - (editing ? 2 : 0) - Array.from(refOf(item)).length - used
      return room >= 8 ? fit(item.title, room) : ''
    }

    /** A row's marker, reference, and title. */
    const body = (item: QueueItem, isHidden: boolean, title: string, scope?: string) => {
      const ref = refOf(item)
      const state = status[ref]
      const marker = state === undefined || state === 'starting' ? '○' : state === 'posted' ? '✓' : '●'
      if (isHidden) {
        return <Text key="hidden-pr" color="inactive" strikethrough>{marker} {ref}{title ? ` ${title}` : ''}</Text>
      }
      const [org, repo] = item.repo.split('/')
      const runHover = (tone?: string) => scope === undefined ? undefined : hover(scope, tone)
      const color = markerColor(state, doing[ref], tick)
      // An array, since a Button holds strings and Text only, never a fragment's Box.
      return [
        <Text key="marker" color={color} hover={runHover(color)}>{marker}</Text>,
        <Text key="gap"> </Text>,
        <Text key="org" color="suggestion" hover={runHover('suggestion')}>{org}</Text>,
        <Text key="slash" dimColor hover={runHover('inactive')}>/</Text>,
        <Text key="repo" color="claude" hover={runHover('claude')}>{repo}</Text>,
        <Text key="number" color="warning" hover={runHover('warning')}>#{item.number}</Text>,
        title ? <Text key="title" hover={runHover()}> {title}</Text> : null,
      ]
    }

    return (
      <Box flexDirection="column">
        {header}
        {rows.map((item, rowIndex) => {
          const ref = refOf(item)
          const state = status[ref]
          const isHidden = hiddenRefs.has(ref)
          const canStart = !isHidden && (state === undefined || state === 'failed')
          const prScope = `pr-${rowIndex}`
          const eyeHover = hover(`eye-${rowIndex}`)
          const choices = isHidden ? [] : offered[ref] ?? []
          // Each button is followed by the space before the next part.
          const used = choices.reduce((n, c) => n + widthOf(c) + 1, 0)
          const title = titleOf(item, used)
          const contents = body(item, isHidden, choices.length > 0 ? '' : title, canStart ? prScope : undefined)
          return (
            <Box key={`row-${ref}`} flexDirection="row">
              {editing ? (
                <Button
                  key={`visibility-${ref}`}
                  label={`${isHidden ? 'Show' : 'Hide'} ${ref}`}
                  plain
                  hover={eyeHover}
                  onPress={() => setHidden($, ref, !isHidden)}
                >
                  <Text hover={eyeHover}>{isHidden ? EYE_CLOSED : EYE}</Text>
                </Button>
              ) : null}
              {editing ? <Text key="visibility-gap"> </Text> : null}
              {canStart ? (
                <Button
                  key={`pr-${ref}`}
                  plain
                  hover={hover(prScope)}
                  onPress={async () => {
                    await markStarting($, [ref])
                    // The command queues a model turn that outlasts the press budget, so it is not awaited.
                    void $.command.run({ command: config.reviewCommand, args: ref }).catch(err =>
                      $.ui.toast(`Could not start the review of ${ref}: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown error'}`),
                    )
                  }}
                >
                  {contents}
                </Button>
              ) : contents}
              {choices.flatMap((choice, choiceIndex) => {
                const scope = `choice-${rowIndex}-${choiceIndex}`
                const bracketHover = hover(scope, BRACKET_COLOR)
                return [
                  <Text key={`choice-gap-${choice.glyph}`}> </Text>,
                  <Button
                    key={`choice-${choice.glyph}-${ref}`}
                    label={choice.action}
                    plain
                    hover={hover(scope)}
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
                      <Text key="open" color={BRACKET_COLOR} hover={bracketHover}>[</Text>,
                      ...(glyphsOf(choice.glyph) ?? []).flatMap((glyph, i) => [
                        <Text key={`glyph-${i}`} color={PALETTE[glyph]!.color} hover={hover(scope, PALETTE[glyph]!.color)}>{glyph}</Text>,
                        PALETTE[glyph]!.isWide ? <Text key={`spill-${i}`}> </Text> : null,
                      ]),
                      <Text key="close" color={BRACKET_COLOR} hover={bracketHover}>]</Text>,
                    ]}
                  </Button>,
                ]
              })}
              {choices.length > 0 && title ? <Text key="title"> {title}</Text> : null}
            </Box>
          )
        })}
        {notShown > 0 ? <Text dimColor>{notShown} more are not shown.</Text> : null}
      </Box>
    )
  })
}
