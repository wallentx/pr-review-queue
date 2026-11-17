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

const A = 'pr-FarmGPU/fgpu_ansible#207'
const B = 'pr-FarmGPU/onepass-client#31'

test('a review goes gray, red, green, then leaves the queue once posted', async ($, on) => {
  const started: string[] = []
  on('command.register', () => ({ value: { command: 'pr-queue' } }))
  on('store.get', () => ({ value: true }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: QUEUE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', { command: 'pr-review-queue' }, (_, e) => {
    started.push(e.args)
    return { text: '' }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 200; i++) await Promise.resolve()

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
    on('store.get', () => ({ value: true }))
    on('clock.every', () => ({ value: undefined }))
    on('process.run', (_, e) => {
      ran.push([...e.argv])
      return { value: { exitCode: 0, stdout: EMPTY, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 200; i++) await Promise.resolve()
    // The test's timer stub fires once at once, so the check can run more than once; each run uses the same argv.
    expect(ran.length).toBeGreaterThan(0)
    for (const one of ran) expect(one).toEqual([...argv])
  })
}
