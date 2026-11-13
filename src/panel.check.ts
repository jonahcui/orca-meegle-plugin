import { defineCheck } from 'orca/testing'

// Synthetic authenticated scenarios are UI fixtures, never real account data.
export default defineCheck({
  live_connection: {},
  logged_out: { requests: { 'meegle.auth': () => ({ ok: true, value: { auth: { authenticated: false, host: 'meegle.com' } } }) } },
  connected: { requests: { 'meegle.auth': () => ({ ok: true, value: { auth: { authenticated: true, host: 'meegle.com' } } }) } },
  connection_error: { requests: { 'meegle.auth': () => ({ ok: false, code: 'cli_missing', error: '未找到 Meegle CLI，请先安装。' }) } }
})
