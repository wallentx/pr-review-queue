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
const settle = async () => {
  for (let i = 0; i < 5000; i++) await Promise.resolve()
}

const A = 'pr-FarmGPU/fgpu_ansible#207'
const B = 'pr-FarmGPU/onepass-client#31'

test('a review goes gray, red, green, then leaves the queue once posted', async ($, on) => {
  const started: string[] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  sharedCache(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', { command: 'pr-review-queue:review' }, (_, e) => {
    started.push(e.args)
    return { text: '' }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()

  const ui = await $.ui.mount({ ...QUEUE_VIEW, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 2/ }))?.text).toBeTruthy()

  await ui.press({ key: 'toggle' })
  const row = await ui.find({ type: 'Button', key: A })
  expect(row).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '○' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '●' })).toBeFalsy()

  // A press starts the command and turns the row red.
  await ui.press({ key: A })
  expect(started).toEqual(['FarmGPU/fgpu_ansible#207'])
  expect((await ui.find({ type: 'Text', text: '●' }))?.props?.color).toBe('error')

  // The reviewer subagent finishing turns it green.
  // The test fills only the fields the mod reads; the engine fills the rest in a session.
  await $.agent.spawn({ prompt: 'Review PR: FarmGPU/fgpu_ansible#207 read-only.' } as Parameters<typeof $.agent.spawn>[0])
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'agent-1' } as Parameters<typeof $.turn.complete>[0])
  expect((await ui.find({ type: 'Text', text: '●' }))?.props?.color).toBe('success')

  // Posting the review removes the row; the other PR stays.
  await $.tool.call({ tool: 'Bash', command: 'gh pr review 207 --repo FarmGPU/fgpu_ansible --approve --body-file /tmp/x.md' })
  expect(await ui.find({ type: 'Button', key: A })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: B })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Reviews waiting: 1/ }))?.text).toBeTruthy()
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

test('the square edits the list: the cross hides a row, the eye lists hidden rows, the arrow restores one', async ($, on) => {
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
  expect(await ui.find({ type: 'Text', text: '□' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '▼' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: HIDE_A })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: HIDE_B })).toBeTruthy()
  // No pull request is hidden yet, so there is no eye.
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
  expect(store.get('hiddenRefs')).toEqual(['FarmGPU/fgpu_ansible#207'])

  // The eye lists hidden rows struck through, each with a restore arrow.
  await ui.press({ key: 'show-hidden' })
  const restore = await ui.find({ type: 'Button', key: RESTORE_A })
  expect(restore).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '↺' })).toBeTruthy()
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
  const store = new Map<string, unknown>([['hiddenRefs', ['FarmGPU/fgpu_ansible#207', 'acme/gone#9']]])
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('clock.every', () => ({ value: undefined }))
  sharedCache(on, new Map(), { now: 1_000_000 }, true, {}, store)
  on('process.run', () => ({ value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await queueSwitch($, 'on')
  await settle()
  expect(store.get('hiddenRefs')).toEqual(['FarmGPU/fgpu_ansible#207'])
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
  expect(store.get('hiddenRefs')).toEqual(['FarmGPU/fgpu_ansible#207'])
})
