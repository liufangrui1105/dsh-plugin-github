/**
 * 测试用：把 `git http-backend`（CGI）桥接到一个本地 HTTP 服务上，
 * 从而在没有网络、也没有 sh.exe 的情况下验证真实的 git smart HTTP 链路
 * （clone / fetch / push）。
 *
 * 桥接本身也用「文件描述符 stdio」跑子进程：受限沙箱下管道 stdio 会 EPERM，
 * 这与 src/git.js 采用同一套策略。
 */

import http from 'node:http'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '../src/git.js'

/** 解析 CGI 输出：Status 头 + 其余头 + body（兼容 chunked 包裹）。 */
function parseCgi(raw) {
  const separator = raw.indexOf('\r\n\r\n')
  const headerText = separator < 0 ? raw.toString('latin1') : raw.subarray(0, separator).toString('latin1')
  const body = separator < 0 ? Buffer.alloc(0) : raw.subarray(separator + 4)
  const lines = headerText.split('\r\n').filter(Boolean)
  let status = 200
  const headers = {}
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index < 0) continue
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (name.toLowerCase() === 'status') {
      status = Number(value.split(' ')[0]) || 200
      continue
    }
    headers[name] = value
  }
  return { status, headers, body }
}

/** chunked 响应体的解码（git http-backend 对 POST 用 chunked）。 */
function dechunk(body) {
  if (body.length === 0) return body
  const parts = []
  let offset = 0
  for (;;) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd < 0) return body
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('latin1').trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    const start = lineEnd + 2
    parts.push(body.subarray(start, start + size))
    offset = start + size + 2
  }
  return parts.length === 0 ? body : Buffer.concat(parts)
}

/**
 * 启动一个只服务一个仓库的 smart HTTP 端点。
 * @param {string} projectRoot 包含 `<name>.git` 的目录
 * @param {string} repoName 仓库目录名（例如 origin.git）
 * @returns {Promise<{url: string, close: () => Promise<void>, projectRoot: string}>}
 */
export async function startGitHttp(projectRoot, repoName = 'origin.git') {
  const execPath = (await runProcess('git', ['--exec-path'])).stdout.trim()
  const backend = path.join(execPath, process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend')
  const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-gh-cgi-'))

  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      let body = Buffer.concat(chunks)
      if ((request.headers['transfer-encoding'] ?? '').includes('chunked')) body = dechunk(body)

      const requestUrl = new URL(request.url, 'http://127.0.0.1')
      const stdinFile = path.join(scratch, 'in.bin')
      const stdoutFile = path.join(scratch, 'out.bin')
      const stderrFile = path.join(scratch, 'err.bin')
      writeFileSync(stdinFile, body)
      const stdinFd = openSync(stdinFile, 'r')
      const stdoutFd = openSync(stdoutFile, 'w')
      const stderrFd = openSync(stderrFile, 'w')
      let result
      try {
        result = spawnSync(backend, [], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: projectRoot,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: request.method,
            PATH_INFO: requestUrl.pathname,
            QUERY_STRING: requestUrl.search.replace(/^\?/, ''),
            CONTENT_TYPE: request.headers['content-type'] ?? '',
            CONTENT_LENGTH: String(body.length),
            REMOTE_USER: 'tester',
            GIT_COMMITTER_NAME: 'tester',
            GIT_COMMITTER_EMAIL: 'tester@example.com',
            GIT_AUTHOR_NAME: 'tester',
            GIT_AUTHOR_EMAIL: 'tester@example.com',
          },
          stdio: [stdinFd, stdoutFd, stderrFd],
          windowsHide: true,
        })
      } finally {
        closeSync(stdinFd)
        closeSync(stdoutFd)
        closeSync(stderrFd)
      }

      const raw = readFileSync(stdoutFile)
      const cgi = parseCgi(raw)
      if (result.status !== 0) {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end(`git http-backend 退出码 ${result.status}\n${readFileSync(stderrFile, 'utf8')}`)
        return
      }
      const payload = (cgi.headers['Transfer-Encoding'] ?? '').toLowerCase() === 'chunked'
        ? dechunk(cgi.body)
        : cgi.body
      const headers = { ...cgi.headers }
      delete headers['Transfer-Encoding']
      delete headers.Status
      headers['Content-Length'] = String(payload.length)
      response.writeHead(cgi.status, headers)
      response.end(payload)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/${repoName}`,
    projectRoot,
    async close() {
      await new Promise(resolve => server.close(resolve))
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    },
  }
}
