import { openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'

let out, err
const close = () => { for (const fd of [out, err]) { if (fd !== undefined) try { closeSync(fd) } catch {} } }
try {
  const input = await new Promise((resolve, reject) => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => resolve(text)); process.stdin.on('error', reject) })
  const spec = JSON.parse(input)
  if (!spec || typeof spec.executable !== 'string' || !Array.isArray(spec.args) || ![spec.stdoutPath, spec.stderrPath].every(value => typeof value === 'string')) throw new Error('invalid launch envelope')
  out = openSync(spec.stdoutPath, 'a'); err = openSync(spec.stderrPath, 'a')
  const child = spawn(spec.executable, spec.args, { detached: true, shell: false, windowsHide: true, stdio: ['ignore', out, err], env: process.env })
  child.once('spawn', () => { process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`); close(); child.unref() })
  child.once('error', error => { close(); process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
} catch (error) { close(); process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
