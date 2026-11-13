import { assert, test } from 'orca/testing'
import { MeegleCli, type Runner } from './cli'
import { AppError } from './errors'

// Synthetic protocol fixtures, not captured account responses.
test('unauthenticated requests never inspect or execute business commands', async () => {
  const calls: string[][] = []
  const runner: Runner = async (args) => { calls.push(args); return { authenticated: false, host: 'meegle.com' } }
  const cli = new MeegleCli(runner)
  await assert.rejects(cli.business('project.search', { page_num: 1 }), /登录/)
  assert.deepEqual(calls, [['auth', 'status', '--format', 'json']])
})

test('inspects schema and passes hostile input as one JSON argument', async () => {
  const calls: string[][] = []
  const runner: Runner = async (args) => {
    calls.push(args)
    if (args[0] === 'auth') return { authenticated: true, host: 'meegle.com', token: 'must-not-leak' }
    if (args[0] === 'inspect') return { parameters: { properties: { project_key: {}, page_num: {} } } }
    return { projects: [] }
  }
  const cli = new MeegleCli(runner)
  const query = 'x;$(touch /tmp/do-not-run) `whoami`'
  assert.deepEqual(await cli.auth(), { authenticated: true, host: 'meegle.com' })
  await cli.business('project.search', { project_key: query, page_num: 2 })
  assert.deepEqual(calls.at(-1), ['project', 'search', '--params', JSON.stringify({ project_key: query, page_num: 2 }), '--format', 'json'])
})

test('unknown schema fails closed', async () => {
  const cli = new MeegleCli(async (args) => args[0] === 'auth' ? { authenticated: true, host: 'meegle.com' } : {})
  await assert.rejects(cli.business('project.search', { page_num: 1 }), /schema/)
})

test('does not expose process stderr or credentials', async () => {
  const cli = new MeegleCli(async () => { throw new Error('access_token=super-secret') })
  await assert.rejects(cli.auth(), (error: unknown) => error instanceof Error && !error.message.includes('super-secret'))
})

test('auth status exit 1 with structured false is a valid logged-out state', async () => {
  const { processOutput } = await import('./cli')
  assert.deepEqual(processOutput(['auth', 'status', '--format', 'json'], 1, '{"authenticated":false,"host":"meegle.com"}'), { authenticated: false, host: 'meegle.com' })
  assert.throws(() => processOutput(['project', 'search'], 1, '{"projects":[]}'), /失败/)
  assert.throws(() => processOutput(['auth', 'status'], 1, '{"authenticated":true}'), /失败/)
})

test('installed CLI inspect uses text even when format json is requested', async () => {
  const { processOutput } = await import('./cli')
  const text = '\n  meegle project search\n  Resolve space\n\n  Optional parameters:\n    --project-key <string>\n      Space name\n    --page-num <number>\n      Page\n    --params <json>\n'
  const schema = processOutput(['inspect', 'project.search', '--format', 'json'], 0, text)
  assert.deepEqual(schema, { parameters: [{ name: 'project_key', type: 'string' }, { name: 'page_num', type: 'number' }, { name: 'params', type: 'json' }] })
  assert.throws(() => processOutput(['inspect', 'project.search'], 0, 'No commands available'), /schema/)
})

test('auth and inspect are cached; a failed call re-checks auth next time', async () => {
  const calls: string[] = []
  let clock = 0, fail = false
  const run = async (args: string[]) => {
    calls.push(args.slice(0, 2).join(' '))
    if (args[0] === 'auth') return { authenticated: true, host: 'meegle.com' }
    if (args[0] === 'inspect') return { parameters: [{ name: 'project_key' }] }
    if (fail) throw new AppError('remote_error', 'x')
    return { data: [] }
  }
  const cli = new MeegleCli(run, () => clock)
  await cli.business('project.search', { project_key: 'a' })
  await cli.business('project.search', { project_key: 'b' })
  assert.deepEqual(calls, ['auth status', 'inspect project.search', 'project search', 'project search'])
  clock = 61_000
  await cli.business('project.search', { project_key: 'c' })
  assert.equal(calls.filter(c => c === 'auth status').length, 2)
  fail = true
  await assert.rejects(cli.business('project.search', { project_key: 'd' }))
  fail = false
  await cli.business('project.search', { project_key: 'e' })
  assert.equal(calls.filter(c => c === 'auth status').length, 3)
  assert.equal(calls.filter(c => c.startsWith('inspect')).length, 1)
})
