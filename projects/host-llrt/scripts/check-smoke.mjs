import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const deployment = await mkdtemp(join(tmpdir(), 'pluxel-llrt-'))
const runtime = join(deployment, 'runtime')
const unavailable = 'target_unavailable'
const tickets = { tickets: ['desk-1', 'desk-2'], encryptedVault: { read: 'desk-2', deleted: true } }

try {
	const build = await exec(
		'cargo',
		['build', '--locked', '--manifest-path', 'native/Cargo.toml', '--message-format=json'],
		{ maxBuffer: 8 * 1024 * 1024 },
	)
	const executable = build.stdout
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.find(
			(message) => message.target?.name === 'pluxel-host-llrt' && message.executable,
		)?.executable
	assert.ok(executable, 'Cargo must emit the Rust host executable')
	const binary = join(deployment, basename(executable))
	await cp(executable, binary)
	await cp('build/runtime', runtime, { recursive: true })
	const run = async (...actions) => {
		const { stdout } = await exec(binary, [runtime, ...actions], { cwd: deployment })
		return stdout
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
	}
	const [initial] = await run()
	assert.equal(initial.ticket, unavailable)

	// Build B only after the deployed binary has booted without it.
	await exec('vp', ['exec', 'pluxel', 'build'])
	const release = resolve('dist/index.js')
	const digest = createHash('sha256')
		.update(await readFile(release))
		.digest('hex')
	const boots = await run('boot', 'install', release, digest, 'uninstall')
	assert.deepEqual(
		boots.map((boot) => boot.ticket),
		[unavailable, tickets, unavailable],
	)
	assert.equal(new Set(boots.map((boot) => boot.shared.first.generation)).size, 3)
	assert.equal(new Set(boots.map((boot) => boot.pid)).size, 1)
	assert.equal(new Set(boots.map((boot) => boot.runtime)).size, 3)
	for (const { shared } of boots)
		assert.deepEqual([shared.first.visits, shared.second.visits], [1, 2])

	// A new OS process reads the same installed bytes. A rejected replacement preserves them.
	const [installed] = await run('install', release, digest)
	await assert.rejects(run('install', release, '0'.repeat(64)), (error) =>
		error.stderr.includes('SHA-256 mismatch'),
	)
	await assert.rejects(run('install', join(deployment, 'missing.js'), digest), (error) =>
		error.stderr.includes('NotFound'),
	)
	const reopened = await run('boot', 'uninstall')
	assert.notEqual(reopened[0].pid, installed.pid)
	assert.notEqual(reopened[0].runtime, installed.runtime)
	assert.deepEqual(
		reopened.map((boot) => boot.ticket),
		[tickets, unavailable],
	)
	const selected = join(runtime, 'installed/ticket.mjs')
	await writeFile(selected, "throw new Error('unreadable TicketDesk release')")
	await assert.rejects(run(), (error) => error.stderr.includes('unreadable TicketDesk release'))
	const [recovered] = await run('uninstall')
	assert.equal(recovered.ticket, unavailable)
	await mkdir(selected)
	await assert.rejects(run(), (error) => error.stderr.includes('regular ESM file'))
	console.log(JSON.stringify({ boots, reopened: reopened.map((boot) => boot.ticket) }))
} finally {
	await rm(deployment, { recursive: true, force: true })
}
