import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { AuthState } from './protocol'
import { AppError, problem } from './errors'

export type Runner = (args: string[], signal?: AbortSignal) => Promise<unknown>
const READ_COMMANDS = new Set(['project.search', 'mywork.todo', 'workitem.meta-types', 'workitem.meta-fields', 'workitem.query', 'workitem.get', 'comment.list', 'user.search'])
type Obj = Record<string, unknown>
function record(value: unknown): Obj { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
export function unwrap(value: unknown): unknown {
  const obj = record(value)
  if (obj.error || (typeof obj.err_code === 'number' && obj.err_code !== 0) || (typeof obj.code === 'number' && obj.code !== 0)) {
    // Raw CLI output can contain sensitive values. Keep it out of the panel and logs.
    problem('remote_error', 'Meegle 返回业务错误。请在终端检查对应命令、权限与参数；面板未保存原始输出。')
  }
  // MQL's native result has a `data` map AND list/session metadata; it is not an envelope.
  const envelopeKeys = new Set(['data', 'meta', 'error', 'code', 'err_code', 'err_msg', 'message'])
  return obj.data !== undefined && Object.keys(obj).every(key => envelopeKeys.has(key)) ? obj.data : value
}

/** No shell is involved; the CLI manages its own credential store. */
export const runProcess: Runner = (args, signal) => new Promise((resolve, reject) => {
  const local = join(homedir(), '.local', 'bin', 'meegle')
  const executable = existsSync(local) ? local : 'meegle'
  execFile(executable, args, { shell: false, encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024, signal }, (error, stdout) => {
    try { resolve(processOutput(args, error ? (error as NodeJS.ErrnoException).code ?? 'unknown' : 0, stdout)) }
    catch (failure) { reject(failure) }
  })
})

export function processOutput(args: string[], code: string | number, stdout: string): unknown {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { /* The error below never includes raw output. */ }
  if (code === 0 && parsed !== undefined) return parsed
  if (code === 0 && args[0] === 'inspect') {
    const command = args[1]?.replace('.', ' ')
    const heading = stdout.split('\n').some(line => line.trim() === `meegle ${command}`)
    const parameters = Array.from(stdout.matchAll(/^ {4}--([a-z0-9-]+) <([^>]+)>/gm), match => ({ name: match[1].replaceAll('-', '_'), type: match[2] }))
    if (heading && parameters.length) return { parameters }
    problem('schema_unknown', '无法识别 inspect schema，请检查登录状态与 CLI 版本。')
  }
  // Official CLI reports a valid unauthenticated state with exit code 1.
  if (code === 1 && args[0] === 'auth' && args[1] === 'status' && record(parsed).authenticated === false) return parsed
  if (code === 0) problem('invalid_response', 'CLI 未返回有效 JSON。请检查 CLI 版本与登录状态。')
  problem(code === 'ENOENT' ? 'cli_missing' : 'cli_failed', code === 'ENOENT'
    ? '未找到 Meegle CLI。请先安装官方 meegle CLI（~/.local/bin/meegle 或 PATH）。'
    : 'Meegle CLI 执行失败或超时。请在终端检查登录、网络和命令；原始输出不会写入面板。')
}

function schemaNames(raw: unknown): Set<string> {
  const obj = record(unwrap(raw))
  // Different official CLI versions expose JSON Schema or a parameter list.
  const containers = [obj.parameters, obj.input_schema, obj.inputSchema, obj.schema, obj.params, obj]
  for (const container of containers) {
    const schema = record(container)
    const properties = record(schema.properties)
    if (Object.keys(properties).length) return new Set(Object.keys(properties))
    if (Array.isArray(container)) {
      const names = container.map(p => { const def = record(p); return def.name ?? def.key ?? def.flag }).filter((n): n is string => typeof n === 'string')
      if (names.length) return new Set(names.map(n => n.replace(/^--/, '').replaceAll('-', '_')))
    }
  }
  problem('schema_unknown', '无法识别 inspect schema。请登录后运行 meegle inspect 对应命令，并按实际 schema 更新适配器。')
}

/** Auth is re-checked at most this often; any failed business call clears it. */
const AUTH_TTL_MS = 60_000

export class MeegleCli {
  private schemas = new Map<string, Set<string>>()
  private authedAt: number | undefined
  constructor(private run: Runner = runProcess, private now: () => number = Date.now) {}
  private async execute(args: string[], signal?: AbortSignal): Promise<unknown> {
    try { return await this.run(args, signal) }
    catch (error) {
      if (error instanceof AppError) throw error
      problem('cli_failed', 'Meegle CLI 执行失败。请检查 CLI、登录与网络；未显示原始输出。')
    }
  }
  /** Always asks the CLI; used for the connection check. */
  async auth(signal?: AbortSignal): Promise<AuthState> {
    const raw = record(unwrap(await this.execute(['auth', 'status', '--format', 'json'], signal)))
    if (typeof raw.authenticated !== 'boolean') problem('invalid_response', '认证状态响应无法识别')
    this.authedAt = raw.authenticated ? this.now() : undefined
    return { authenticated: raw.authenticated, host: typeof raw.host === 'string' ? raw.host : null }
  }
  async requireAuth(signal?: AbortSignal): Promise<AuthState | null> {
    if (this.authedAt !== undefined && this.now() - this.authedAt < AUTH_TTL_MS) return null
    const auth = await this.auth(signal)
    if (!auth.authenticated) problem('unauthenticated', '请先登录 Meegle，再点击“重新检查连接”。')
    return auth
  }
  private async schema(command: string, signal?: AbortSignal, fresh = false): Promise<Set<string>> {
    const cached = this.schemas.get(command)
    if (cached && !fresh) return cached
    const names = schemaNames(await this.execute(['inspect', command, '--format', 'json'], signal))
    this.schemas.set(command, names)
    return names
  }
  async business(command: string, params: Obj, signal?: AbortSignal): Promise<unknown> {
    if (!READ_COMMANDS.has(command)) problem('not_permitted', '插件只支持已列出的只读命令')
    await this.requireAuth(signal)
    let names = await this.schema(command, signal)
    // A cached schema may predate a CLI upgrade: re-inspect once before refusing.
    if (Object.keys(params).some(key => !names.has(key))) names = await this.schema(command, signal, true)
    for (const key of Object.keys(params)) if (!names.has(key)) problem('schema_changed', `inspect schema 未声明参数 ${key}，已停止请求。`)
    try { return unwrap(await this.execute([...command.split('.'), '--params', JSON.stringify(params), '--format', 'json'], signal)) }
    catch (error) { this.authedAt = undefined; throw error }
  }
  async decode(url: string, signal?: AbortSignal): Promise<unknown> {
    return unwrap(await this.execute(['url', 'decode', '--url', url, '--format', 'json'], signal))
  }
}
