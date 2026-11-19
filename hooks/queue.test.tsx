import { expect, test } from 'claude-code/testing'

const QUEUE_VIEW = {
  plugin: 'pr-review-queue',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 50,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const QUEUE = JSON.stringify({
  summary: { total: 2, new: 1, re_review: 1 },
  sources: { search: { status: 'ok' } },
  complete: true,
  items: [
    { repo: 'FarmGPU/fgpu_ansible', number: 207, title: 'Add a PDU check that is long enough to need cutting short', kind: 'new' },
    { repo: { full_name: 'FarmGPU/onepass-client' }, number: 31, title: 'Fix login', kind: 're_review' },
  ],
})

type Body = Extract<Parameters<typeof test>[1], (...args: any[]) => unknown>
type On = Parameters<Body>[1]

/** Runs `/pr-queue <args>`. The test fills only the fields the mod reads; the engine fills the rest in a session. */
const queueSwitch = ($: Parameters<Body>[0], args: string) =>
  $.command.run({ command: 'pr-queue', args } as Parameters<typeof $.command.run>[0])

const CACHE = '/home/me/.cache/pr-review-queue'

/** An in-memory file system and clock standing in for the shared cache file. */
function sharedCache(
  on: On,
  files: Map<string, string> = new Map(),
  clock = { now: 1_000_000 },
  isWritable = true,
  env: Record<string, string> = {},
  store: Map<string, unknown> = new Map(),
) {
  // The session registers the tool that offers choice buttons.
  on('tool.register', () => ({ value: { tool: 'mcp__pr-review-queue__offer_choices' } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_, e) => ({ value: { HOME: '/home/me', ...env }[e.name] }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    if (!isWritable) throw new Error('EACCES')
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: clock.now }))
  on('clock.sleep', () => ({ value: undefined }))
  return files
}

/** The one cache file a test wrote, parsed. */
function onlyFile(files: Map<string, string>): any {
  const paths = [...files.keys()].filter(path => path.startsWith(`${CACHE}/queue-`))
  expect(paths.length).toBe(1)
  return JSON.parse(files.get(paths[0]!)!)
}

/** Lets the check the command started run to its end; each engine call takes several microtasks. */
/** Each line of the drawing as its text, so a test sees which plain spaces sit between the parts. */
async function linesOf(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const textOf = (node: any): string =>
    typeof node === 'string' ? node : Array.isArray(node?.children) ? node.children.map(textOf).join('') : ''
  const root = (await ui.drawn()) as any
  return (root?.children ?? []).map(textOf)
}

const settle = async () => {
  for (let i = 0; i < 5000; i++) await Promise.resolve()
}

const A = 'pr-FarmGPU/fgpu_ansible#207'
const B = 'pr-FarmGPU/onepass-client#31'

/** Sets up a session with the queue on and the review command, a subagent and a turn's end answered. */
async function reviewSession(
  $: Parameters<Body>[0],
  on: On,
  // A queue check reads the agent list, which holds a spawned reviewer until it ends.
  agentList: { id: string; status: string }[] = [{ id: 'agent-1', status: 'running' }],
) {
  const started: string[] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  sharedCache(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: agentList as never }))
  on('command.run', { command: 'pr-review-queue:review' }, (_, e) => {
    started.push(e.args)
    return { text: '' }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  await ui.press({ key: 'toggle' })
  return { ui, started }
}

// The test fills only the fields the mod reads; the engine fills the rest in a session.
const spawn = ($: Parameters<Body>[0]) =>
  $.agent.spawn({ prompt: 'Review PR: FarmGPU/fgpu_ansible#207 read-only.' } as Parameters<typeof $.agent.spawn>[0])
const turnStart = ($: Parameters<Body>[0], turnId: string, text: string) =>
  $.turn.start({ turnId, text } as Parameters<typeof $.turn.start>[0])
const turnEnd = ($: Parameters<Body>[0], reason: string, ids: { turnId: string; agentId?: string }) =>
  $.turn.complete({ reason, durationMs: 1, ...ids } as Parameters<typeof $.turn.complete>[0])

/** The color and glyph of the first row's dot. */
async function dotOf(ui: { drawn: () => Promise<unknown> }): Promise<{ glyph: string; color: string }> {
  await settle()
  const root = (await ui.drawn()) as any
  const row = root.children[1]
  const button = row.children.find((c: any) => c.type === 'Button')
  const marker = button.children[0]
  return { glyph: marker.children.join(''), color: marker.props?.color }
}

test('a review goes gray, yellow, pulsing, green, then posted with a check that stays listed', async ($, on) => {
  const { ui, started } = await reviewSession($, on)
  expect(await dotOf(ui)).toEqual({ glyph: '○', color: 'inactive' })

  // A press runs the command and turns the dot yellow until a subagent takes the review.
  await ui.press({ key: A })
  expect(started).toEqual(['FarmGPU/fgpu_ansible#207'])
  expect(await dotOf(ui)).toEqual({ glyph: '○', color: 'warning' })

  // The subagent that names the PR makes the dot a pulsing filled circle.
  await spawn($)
  const running = await dotOf(ui)
  expect(running.glyph).toBe('●')
  expect(running.color).toMatch(/^#[0-9a-f]{6}$/)

  // Its turn ending with an answer turns the dot green.
  await turnEnd($, 'answer', { turnId: 't1', agentId: 'agent-1' })
  expect(await dotOf(ui)).toEqual({ glyph: '●', color: 'success' })

  // Posting the review keeps the row, marks it with a check, and drops it from the count.
  await $.tool.call({ tool: 'Bash', command: 'gh pr review 207 --repo FarmGPU/fgpu_ansible --approve --body-file /tmp/x.md' })
  expect(await ui.find({ type: 'Button', key: A })).toBeTruthy()
  expect(await dotOf(ui)).toEqual({ glyph: '✓', color: 'suggestion' })
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 1/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('stopping the reviewer turns the dot gray, and the row can be picked again', async ($, on) => {
  const { ui, started } = await reviewSession($, on)
  await ui.press({ key: A })
  await spawn($)
  await turnEnd($, 'aborted', { turnId: 't1', agentId: 'agent-1' })
  expect(await dotOf(ui)).toEqual({ glyph: '○', color: 'inactive' })
  await ui.press({ key: A })
  expect(started).toHaveLength(2)
  await ui.unmount()
})

test('stopping the command before a subagent starts turns the dot gray', async ($, on) => {
  const { ui } = await reviewSession($, on)
  await ui.press({ key: A })
  // Another main turn ending does not settle it; only the turn that names the PR does.
  await turnEnd($, 'aborted', { turnId: 'other' })
  expect(await dotOf(ui)).toEqual({ glyph: '○', color: 'warning' })
  await turnStart($, 'm1', 'Review pull request FarmGPU/fgpu_ansible#207.')
  await turnEnd($, 'aborted', { turnId: 'm1' })
  expect(await dotOf(ui)).toEqual({ glyph: '○', color: 'inactive' })
  await ui.unmount()
})

test('a review the main conversation finished without a subagent turns green', async ($, on) => {
  const { ui } = await reviewSession($, on)
  await ui.press({ key: A })
  await turnStart($, 'm1', 'Review pull request FarmGPU/fgpu_ansible#207.')
  await turnEnd($, 'answer', { turnId: 'm1' })
  expect(await dotOf(ui)).toEqual({ glyph: '●', color: 'success' })
  await ui.unmount()
})

test('a failed reviewer turns the dot red, and the row can be picked again', async ($, on) => {
  const { ui, started } = await reviewSession($, on)
  await ui.press({ key: A })
  await spawn($)
  await turnEnd($, 'error', { turnId: 't1', agentId: 'agent-1' })
  expect(await dotOf(ui)).toEqual({ glyph: '●', color: 'error' })
  await ui.press({ key: A })
  expect(started).toHaveLength(2)
  await ui.unmount()
})

test('a reviewer the agent list shows as killed turns the dot gray on the next check', async ($, on) => {
  const agentList = [{ id: 'agent-1', status: 'running' }]
  const { ui } = await reviewSession($, on, agentList)
  await ui.press({ key: A })
  await spawn($)
  expect((await dotOf(ui)).glyph).toBe('●')
  agentList[0]!.status = 'killed'
  await queueSwitch($, 'off')
  await queueSwitch($, 'on')
  await settle()
  await ui.press({ key: 'toggle' })
  expect(await dotOf(ui)).toEqual({ glyph: '○', color: 'inactive' })
  await ui.unmount()
})

test('a disabled queue draws nothing of its own', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('store.get', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

const EMPTY = JSON.stringify({ summary: { total: 0 }, sources: { search: { status: 'ok' } }, complete: true, items: [] })

for (const [name, options, argv] of [
  ['the defaults find AID.review-queue on PATH and let it infer the owner', {}, ['AID.review-queue', '--json']],
  [
    'the options set the executable, owner and workspace',
    { aidPath: '/opt/aid/AID.review-queue', owner: 'acme', workspace: '/home/me/src' },
    ['/opt/aid/AID.review-queue', '--json', '--owner', 'acme', '--workspace', '/home/me/src'],
  ],
] as const) {
  test(name, { options }, async ($, on) => {
    const ran: string[][] = []
    on('command.register', () => ({ value: { command: 'pr-queue' } }))
    on('clock.every', () => ({ value: undefined }))
    sharedCache(on)
    on('process.run', (_, e) => {
      ran.push([...e.argv])
      return { value: { exitCode: 0, stdout: EMPTY, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await queueSwitch($, 'on')
    await settle()
    expect(ran.length).toBeGreaterThan(0)
    for (const one of ran) expect(one).toEqual([...argv])
  })
}

test('a new session starts off even when an older version stored the queue as on', async ($, on) => {
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, new Map([['isEnabled', true]]))
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: EMPTY, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(ran).toEqual([])
})

test('a session shows a fresh result another session fetched, without running AID.review-queue', async ($, on) => {
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const files = sharedCache(on)
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  // A first session fetches and writes the shared file.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(1)
  const shared = onlyFile(files)
  expect(shared.result.total).toBe(2)
  expect(shared.claimedBy).toBeUndefined()

  // Turning the queue off and on again within 5 minutes reuses that file.
  await queueSwitch($, 'off')
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(1)
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 2/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('a session waits while another session holds the claim to fetch', async ($, on) => {
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  const files = sharedCache(on)
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Learn the file's name from a first fetch, then hand the claim to another session.
  await queueSwitch($, 'on')
  await settle()
  const path = [...files.keys()][0]!
  files.set(path, JSON.stringify({ claimedBy: 'other-session', claimedAt: 1_000_000 }))
  await queueSwitch($, 'off')
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(1)
  expect(onlyFile(files).claimedBy).toBe('other-session')
})

test('a session takes over a claim older than the fetch timeout', async ($, on) => {
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  const files = sharedCache(on)
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  const path = [...files.keys()][0]!
  files.set(path, JSON.stringify({ claimedBy: 'gone-session', claimedAt: 1_000_000 - 151_000 }))
  await queueSwitch($, 'off')
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(2)
  expect(onlyFile(files).result.total).toBe(2)
})

test('a cache directory that cannot be written leaves the session checking on its own', async ($, on) => {
  const ran: string[][] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, false)
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(1)
  expect(toasts.some(text => text.includes('shared cache'))).toBe(true)
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 2/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('a shared file left truncated is written over after a minute', async ($, on) => {
  const ran: string[][] = []
  const clock = { now: 1_000_000 }
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  const files = sharedCache(on, new Map(), clock)
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Learn the file's name from a first fetch, then truncate the file.
  await queueSwitch($, 'on')
  await settle()
  const path = [...files.keys()][0]!
  files.set(path, '{"fetch')
  clock.now += 6 * 60_000
  await queueSwitch($, 'off')
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(1)

  clock.now += 61_000
  await queueSwitch($, 'off')
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(2)
  expect(onlyFile(files).result.total).toBe(2)
})

test('sessions signed in to GitHub differently keep separate results', async ($, on) => {
  const ran: string[][] = []
  const env: Record<string, string> = { GH_TOKEN: 'first-account' }
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  const files = sharedCache(on, new Map(), { now: 1_000_000 }, true, env)
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()

  // The same mod started again under another token picks another file and fetches its own result.
  env.GH_TOKEN = 'second-account'
  await queueSwitch($, 'off')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  expect(ran.length).toBe(2)
  expect(files.size).toBe(2)
  for (const text of files.values()) expect(text.includes('account')).toBe(false)
})

test('the square edits the list: the cross hides a row, the circle arrow lists hidden rows and restores one', async ($, on) => {
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  const HIDE_A = 'hide-FarmGPU/fgpu_ansible#207'
  const HIDE_B = 'hide-FarmGPU/onepass-client#31'
  const RESTORE_A = 'restore-FarmGPU/fgpu_ansible#207'

  // Collapsed: a half-filled square, then the count and a right triangle.
  expect(await ui.find({ type: 'Text', text: '◧' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '▶' })).toBeTruthy()

  // The square expands the list and puts a cross on every row.
  await ui.press({ key: 'edit' })
  expect(await ui.find({ type: 'Text', text: '◨' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '▼' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: HIDE_A })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: HIDE_B })).toBeTruthy()
  // No pull request is hidden yet, so the header has no arrow.
  expect(await ui.find({ type: 'Button', key: 'show-hidden' })).toBeFalsy()

  // The square again removes the crosses and keeps the list open.
  await ui.press({ key: 'edit' })
  expect(await ui.find({ type: 'Button', key: HIDE_A })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: A })).toBeTruthy()

  // A cross hides its row in the store and drops it from the count.
  await ui.press({ key: 'edit' })
  await ui.press({ key: HIDE_A })
  expect(await ui.find({ type: 'Button', key: A })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 1/ }))?.text).toBeTruthy()
  expect((store.get('hiddenRefs') as { ref: string }[]).map(entry => entry.ref)).toEqual(['FarmGPU/fgpu_ansible#207'])

  // A plain space follows each control glyph.
  const lines = await linesOf(ui)
  expect(lines[0]).toStartWith('◨ ⟲ Reviews waiting: 1')
  expect(lines[1]).toStartWith('⨯ ○ ')

  // The header's arrow lists hidden rows struck through, each with its own green arrow.
  await ui.press({ key: 'show-hidden' })
  const restore = await ui.find({ type: 'Button', key: RESTORE_A })
  expect(restore).toBeTruthy()
  const arrows = await ui.findAll({ type: 'Text', text: '⟲' })
  expect(arrows).toHaveLength(2)
  for (const arrow of arrows) expect(arrow.props).toMatchObject({ color: 'success', bold: true })
  expect((await linesOf(ui)).some(line => line.startsWith('⟲ ○ FarmGPU/fgpu_ansible#207'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'fgpu_ansible' }))?.props?.strikethrough).toBe(true)

  // The arrow restores the row to the regular list.
  await ui.press({ key: RESTORE_A })
  expect(await ui.find({ type: 'Button', key: A })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: RESTORE_A })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'show-hidden' })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 2/ }))?.text).toBeTruthy()
  expect(store.get('hiddenRefs')).toEqual([])
  await ui.unmount()
})

test('a hidden pull request that stops waiting for review is forgotten', async ($, on) => {
  // Bare refs were stored before queries were recorded, so any session's complete check may forget them.
  const store = new Map<string, unknown>([['hiddenRefs', ['FarmGPU/fgpu_ansible#207', 'acme/gone#9']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  expect((store.get('hiddenRefs') as { ref: string }[]).map(entry => entry.ref)).toEqual(['FarmGPU/fgpu_ansible#207'])
})

test('a queue whose every pull request is hidden still draws its line', async ($, on) => {
  const store = new Map<string, unknown>([['hiddenRefs', ['FarmGPU/fgpu_ansible#207', 'FarmGPU/onepass-client#31']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 0/ }))?.text).toBeTruthy()
  await ui.press({ key: 'edit' })
  expect(await ui.find({ type: 'Button', key: 'show-hidden' })).toBeTruthy()
  await ui.unmount()
})

test('unhide with a pull request shows only that one again', async ($, on) => {
  const store = new Map<string, unknown>([['hiddenRefs', ['FarmGPU/fgpu_ansible#207', 'FarmGPU/onepass-client#31']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const answer = (await queueSwitch($, 'unhide FarmGPU/onepass-client#31')) as { text: string }
  expect(answer.text).toBe('1 hidden pull request is shown again.')
  expect((store.get('hiddenRefs') as { ref: string }[]).map(entry => entry.ref)).toEqual(['FarmGPU/fgpu_ansible#207'])
})

test('a gh api POST to a pull request reviews endpoint counts as a posted review', async ($, on) => {
  const { ui } = await reviewSession($, on)
  // Reading reviews, or replying under a review's comments, posts nothing.
  await $.tool.call({ tool: 'Bash', command: 'gh api repos/FarmGPU/fgpu_ansible/pulls/207/reviews --jq .[].state' })
  await $.tool.call({ tool: 'Bash', command: 'gh api -X POST repos/FarmGPU/fgpu_ansible/pulls/207/reviews/9/events -f event=APPROVE' })
  expect((await dotOf(ui)).glyph).toBe('○')
  await $.tool.call({
    tool: 'Bash',
    command: 'head=$(gh pr view 207 --json headRefOid -q .headRefOid) && gh api -X POST repos/FarmGPU/fgpu_ansible/pulls/207/reviews --input /tmp/review.json',
  })
  expect(await dotOf(ui)).toEqual({ glyph: '✓', color: 'suggestion' })
  await ui.unmount()
})

const OFFER = 'mcp__pr-review-queue__offer_choices'
const offer = ($: Parameters<Body>[0], ref: string, choices: { glyph: string; action: string }[]) =>
  $.tool.call({ tool: OFFER, ref, choices } as unknown as Parameters<typeof $.tool.call>[0])

const APPROVE = { glyph: '✓', action: 'Approve FarmGPU/fgpu_ansible#207 with no comments.' }
const NITS = { glyph: '✓🗩', action: 'Approve FarmGPU/fgpu_ansible#207 and post the two nits as comments.' }
const BLOCK = { glyph: '⊘', action: 'Request changes on FarmGPU/fgpu_ansible#207 for the missing PDU timeout.' }

test('offered choices show as bracketed buttons after the pull request, and a press sends its action', async ($, on) => {
  const submitted: { text: string; asUser?: boolean }[] = []
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, asUser: (e.origin as { asUser?: boolean } | undefined)?.asUser })
    return { text: e.text }
  })
  const { ui } = await reviewSession($, on)

  // The buttons keep the agent's order, and the title takes whatever room is left.
  const answer = await offer($, 'FarmGPU/fgpu_ansible#207', [NITS, APPROVE, BLOCK])
  expect(JSON.stringify(answer)).toContain('shows ✓🗩 ✓ ⊘ on FarmGPU/fgpu_ansible#207')
  await settle()
  expect((await linesOf(ui))[1]).toBe('○ FarmGPU/fgpu_ansible#207 [✓🗩 ] [✓] [⊘] Add a P…')

  // The brackets are light blue, the check green, and the request-changes sign red.
  const button = (await ui.find({ type: 'Button', key: 'choice-⊘-FarmGPU/fgpu_ansible#207' })) as any
  expect(button.children.map((t: any) => t.props?.color)).toEqual(['#87cefa', 'error', '#87cefa'])

  await ui.press({ key: 'choice-✓🗩-FarmGPU/fgpu_ansible#207' })
  await settle()
  expect(submitted).toEqual([{ text: `✓🗩 ${NITS.action}`, asUser: true }])
  // The press takes the buttons away and gives the title its room back.
  expect((await linesOf(ui))[1]).toMatch(/^○ FarmGPU\/fgpu_ansible#207 Add a PDU check/)
  await ui.unmount()
})

test('posting a review takes its choice buttons away', async ($, on) => {
  const { ui } = await reviewSession($, on)
  await offer($, 'FarmGPU/fgpu_ansible#207', [APPROVE, { glyph: '🗩', action: 'Comment on FarmGPU/fgpu_ansible#207.' }])
  await settle()
  expect((await linesOf(ui))[1]).toBe('○ FarmGPU/fgpu_ansible#207 [✓] [🗩 ] Add a PDU ch…')
  await $.tool.call({ tool: 'Bash', command: 'gh pr review 207 --repo FarmGPU/fgpu_ansible --approve' })
  await settle()
  expect((await linesOf(ui))[1]).toMatch(/^✓ FarmGPU\/fgpu_ansible#207 Add a PDU check/)
  await ui.unmount()
})

test('an offer with a glyph outside the palette is refused, and one for a pull request not listed says so', async ($, on) => {
  const { ui } = await reviewSession($, on)
  // A variation selector after a palette glyph is accepted; a glyph outside the palette, or three glyphs, is not.
  expect(JSON.stringify(await offer($, 'FarmGPU/fgpu_ansible#207', [{ glyph: '✓\uFE0F', action: 'Approve.' }]))).not.toContain('deny')
  expect(JSON.stringify(await offer($, 'FarmGPU/fgpu_ansible#207', [{ glyph: '👍', action: 'Approve.' }]))).toContain('deny')
  expect(JSON.stringify(await offer($, 'FarmGPU/fgpu_ansible#207', [{ glyph: '✓🗩🗈', action: 'All.' }]))).toContain('deny')
  expect(JSON.stringify(await offer($, 'FarmGPU/other#1', [APPROVE]))).toContain('is not showing FarmGPU/other#1')
  await ui.unmount()
})

test("a complete check forgets only hidden pull requests its own query hid", async ($, on) => {
  // Another session's query lists other pull requests, so its absence here proves nothing.
  const store = new Map<string, unknown>([['hiddenRefs', [{ ref: 'acme/elsewhere#4', query: 'another-query' }, 'acme/gone#9']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  expect(store.get('hiddenRefs')).toEqual([{ ref: 'acme/elsewhere#4', query: 'another-query' }])
})

test('the list stays drawn after every listed pull request was posted', async ($, on) => {
  const { ui } = await reviewSession($, on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr review 207 --repo FarmGPU/fgpu_ansible --approve' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr review 31 --repo FarmGPU/onepass-client --comment -b ok' })
  await settle()
  const lines = await linesOf(ui)
  expect(lines[0]).toContain('Reviews waiting: 0')
  expect(lines.slice(1).map(line => line.slice(0, 2))).toEqual(['✓ ', '✓ '])
  await ui.unmount()
})

test('hidden rows get room when nine or more pull requests are waiting', async ($, on) => {
  const items = Array.from({ length: 10 }, (_, i) => ({ repo: 'acme/app', number: i + 1, title: `Change ${i + 1}`, kind: 'new' }))
  const many = JSON.stringify({ summary: { total: 10, new: 10, re_review: 0 }, sources: { search: { status: 'ok' } }, complete: true, items })
  const store = new Map<string, unknown>([['hiddenRefs', ['acme/app#10']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: many, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  await ui.press({ key: 'edit' })
  await ui.press({ key: 'show-hidden' })
  await ui.press({ key: 'restore-acme/app#10' })
  await settle()
  expect(store.get('hiddenRefs')).toEqual([])
  await ui.unmount()
})

test('offering buttons opens a collapsed list, and a pull request the list does not draw gets the words-only answer', async ($, on) => {
  const items = Array.from({ length: 11 }, (_, i) => ({ repo: 'acme/app', number: i + 1, title: `Change ${i + 1}`, kind: 'new' }))
  const many = JSON.stringify({ summary: { total: 11, new: 11, re_review: 0 }, sources: { search: { status: 'ok' } }, complete: true, items })
  const store = new Map<string, unknown>([['hiddenRefs', ['acme/app#1']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: many, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  const approve = (ref: string) => [{ glyph: '✓', action: `Approve ${ref}.` }]

  // acme/app#1 is hidden, and acme/app#11 is the tenth waiting row, past the nine the list draws.
  expect(JSON.stringify(await offer($, 'acme/app#1', approve('acme/app#1')))).toContain('is not showing acme/app#1')
  expect(JSON.stringify(await offer($, 'acme/app#11', approve('acme/app#11')))).toContain('is not showing acme/app#11')
  // The list stays collapsed: no row is drawn.
  expect(await ui.find({ type: 'Button', key: 'pr-acme/app#2' })).toBeFalsy()

  // A drawn row's buttons open the collapsed list.
  expect(JSON.stringify(await offer($, 'acme/app#2', approve('acme/app#2')))).toContain('shows ✓ on acme/app#2')
  await settle()
  expect((await linesOf(ui))[1]).toMatch(/^○ acme\/app#2 \[✓\]/)
  await ui.unmount()
})
