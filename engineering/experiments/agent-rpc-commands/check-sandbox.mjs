import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const image = process.env.RPC_SPIKE_IMAGE
if (!image)
	throw new Error('Set RPC_SPIKE_IMAGE to a local image with Node 24; no image is pulled.')
const name = `pluxel-rpc-spike-${process.pid}`
const base = [
	'run',
	'--pull=never',
	'--network=none',
	'--read-only',
	'--memory=64m',
	'--memory-swap=64m',
	'--cpus=0.5',
	'--pids-limit=32',
	'--security-opt=no-new-privileges',
	'--cap-drop=ALL',
]
function docker(args) {
	return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}
function run(code) {
	return spawnSync('docker', [...base, '--rm', image, 'node', '-e', code], {
		encoding: 'utf8',
		timeout: 5000,
	})
}

const host = run(
	`const fs=require('node:fs'); console.log(JSON.stringify({hostVisible:fs.existsSync('/home/ahdg'), memoryMax:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()}))`,
)
assert.equal(host.status, 0, host.stderr)
assert.deepEqual(JSON.parse(host.stdout), { hostVisible: false, memoryMax: '67108864' })
const network = run(
	`fetch('http://1.1.1.1',{signal:AbortSignal.timeout(500)}).then(()=>process.exit(3),()=>console.log('denied'))`,
)
assert.equal(network.status, 0, network.stderr)
assert.equal(network.stdout.trim(), 'denied')
const memory = run(`const blocks=[]; while(true) blocks.push(Buffer.alloc(4*1024*1024,1))`)
assert.equal(
	memory.status,
	137,
	`expected cgroup OOM exit 137, got ${memory.status}: ${memory.stderr}`,
)

const socketDir = mkdtempSync(join(tmpdir(), 'pluxel-rpc-spike-'))
chmodSync(socketDir, 0o777)
const socketPath = join(socketDir, 'gateway.sock')
let started
const admitted = new Promise((resolve) => {
	started = resolve
})
let finish
const actualWork = new Promise((resolve) => {
	finish = resolve
})
let active = 0
const server = createServer((_request, response) => {
	active++
	started()
	void actualWork.then(() => {
		active--
		if (!response.destroyed) response.end('done')
	})
})
await new Promise((resolve) => server.listen(socketPath, resolve))
chmodSync(socketPath, 0o666)
let container
try {
	const code = `const http=require('node:http'); const req=http.request({socketPath:'/rpc/gateway.sock',path:'/invoke',method:'POST'},r=>r.resume()); req.on('error',()=>{}); req.end('x'); setInterval(()=>{},1000)`
	container = docker([
		...base,
		'-d',
		'--name',
		name,
		'--volume',
		`${socketDir}:/rpc`,
		image,
		'node',
		'-e',
		code,
	])
	await Promise.race([
		admitted,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('gateway call did not arrive')), 5000),
		),
	])
	assert.equal(active, 1)
	docker(['kill', container])
	assert.equal(docker(['inspect', container, '--format', '{{.State.ExitCode}}']), '137')
	assert.equal(active, 1, 'sandbox death must not be confused with server work completion')
	finish()
	await actualWork
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(active, 0)
	console.log(
		JSON.stringify(
			{
				hostIsolation: true,
				networkDenied: true,
				memoryExit: memory.status,
				killExit: 137,
				serverWorkTrackedAfterKill: true,
			},
			null,
			2,
		),
	)
} finally {
	finish()
	if (container) {
		try {
			docker(['rm', '-f', container])
		} catch {
			/* already gone */
		}
	}
	await new Promise((resolve) => server.close(resolve))
	rmSync(socketDir, { recursive: true, force: true })
}
