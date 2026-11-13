import { assert, test } from 'orca/testing'
import { OrcaWorkspaces, branchName, defaultBranch } from './orca'

const workspace = (id: string, path: string) => ({ id, name: id, path, branch: null, hostId: null })
function host(lists: ReturnType<typeof workspace>[][], calls: unknown[] = []) {
  let n = 0
  return { has: () => true, call: async (method: string, params?: unknown) => {
    calls.push([method, params])
    if (method === 'workspace.list') return { workspaces: lists[Math.min(n++, lists.length - 1)], truncated: false }
    return { opened: true }
  } } as never
}
const repos = { repos: [{ id: 'r1', kind: 'git', displayName: 'repo', path: '/src/repo' }, { id: 'f1', kind: 'folder', path: '/x' }] }

test('branch names refuse option-like and ref-breaking input', () => {
  assert.equal(branchName('feature-meegle-7'), 'feature-meegle-7')
  assert.equal(defaultBranch('12345678'), 'feature-meegle-12345678')
  for (const bad of ['--force', '-x', 'a..b', 'a b', 'a/', 'x.lock', '']) assert.throws(() => branchName(bad), /分支名/)
})

test('open checks the workspace still exists', async () => {
  const calls: unknown[] = []
  const service = new OrcaWorkspaces(host([[workspace('w1', '/a')]], calls), async () => ({}))
  assert.deepEqual(await service.open('w1'), { opened: true })
  await assert.rejects(service.open('gone'), /不存在/)
  assert.equal(calls.filter(c => (c as string[])[0] === 'workspace.open').length, 1)
})
