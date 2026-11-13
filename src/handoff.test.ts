import { assert, test, mockHost, mountWorker } from 'orca/testing'
import { Handoff, buildPrompt } from './handoff'
import * as main from './worker'
import type { Detail } from './protocol'

const detail: Detail = { id: '7', name: '账单验收', projectKey: 'p1', typeKey: 'custom', description: '允许重试但不能重复扣款', fields: [{ label: '验收', value: '并发仍只扣一次' }] }

test('handoff prompt includes source and full requirements with workspace guardrails', () => {
  const prompt = buildPrompt(detail)
  assert.match(prompt, /p1/); assert.match(prompt, /并发仍只扣一次/)
  assert.match(prompt, /AGENTS.md/); assert.match(prompt, /外部需求资料/)
  assert.match(prompt, /不得.*发布/)
})

test('handoff is bound to requesting panel and launch is idempotent', async () => {
  let launches = 0
  const host = {
    has: () => true,
    call: async (method: string) => {
      if (method === 'workspace.list') return { workspaces: [{ id: 'w1', name: '开发', path: '/tmp/repo', branch: null, hostId: null }], truncated: false }
      launches++; return { terminalId: 't1' }
    }
  }
  const handoff = new Handoff(host as never)
  const preview = handoff.preview(detail, 'panel1')
  await assert.rejects(handoff.launch({ previewId: preview.previewId, workspaceId: 'w1', agent: 'codex' }, 'other'), /预览/)
  const input = { previewId: preview.previewId, workspaceId: 'w1', agent: 'codex' }
  const [a, b] = await Promise.all([handoff.launch(input, 'panel1'), handoff.launch(input, 'panel1')])
  assert.equal(a.terminalId, 't1'); assert.deepEqual(a, b); assert.equal(launches, 1)
  await assert.rejects(handoff.launch({ ...input, agent: 'claude' }, 'panel1'), /目标/)
})

test('missing workspace never starts an agent and uncertain launch is not retried', async () => {
  let launches = 0
  const host = { has: () => true, call: async (method: string) => {
    if (method === 'workspace.list') return { workspaces: [{ id: 'w1', name: '开发', path: '/tmp', branch: null, hostId: null }], truncated: false }
    launches++; throw new Error('timeout')
  } }
  const handoff = new Handoff(host as never), preview = handoff.preview(detail, 'p')
  await assert.rejects(handoff.launch({ previewId: preview.previewId, workspaceId: 'missing', agent: 'codex' }, 'p'), /工作区/)
  assert.equal(launches, 0)
  const input = { previewId: preview.previewId, workspaceId: 'w1', agent: 'codex' }
  await assert.rejects(handoff.launch(input, 'p'), /终端/)
  await assert.rejects(handoff.launch(input, 'p'), /终端/)
  assert.equal(launches, 1)
})

test('worker exposes supported workspace method with declared capability', async () => {
  const host = mockHost({ capabilities: ['workspace:read', 'workspace:write', 'agent:launch'], results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('meegle.workspaces'), { ok: true, value: { workspaces: [], truncated: false } })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
