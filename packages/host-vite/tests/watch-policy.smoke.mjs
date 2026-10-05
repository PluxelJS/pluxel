import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { watch } from 'chokidar'
import { hostFileWatchOptions } from '../src/internal/watch-policy.ts'

async function probe(policy) {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-watch-close-'))
	const file = resolve(root, 'input.mjs')
	await writeFile(file, 'initial')
	const firstPoll = Promise.withResolvers()
	const firstChange = Promise.withResolvers()
	let closed = false
	let filesystemReadsAfterClose = 0
	const hook = createHook({
		init(_id, type) {
			if (type !== 'FSREQCALLBACK') return
			const stack = new Error('Filesystem observer trace').stack.replaceAll('\\', '/')
			if (!stack.includes('/chokidar/')) return
			if (stack.includes('awaitWriteFinishFn')) firstPoll.resolve()
			if (closed) filesystemReadsAfterClose++
		},
	}).enable()
	const watcher = watch(file, { ...policy, ignoreInitial: true })
	try {
		await new Promise((resolveReady, reject) => {
			watcher.once('ready', resolveReady)
			watcher.once('error', reject)
		})
		watcher.once('change', () => firstChange.resolve())
		await writeFile(file, 'first-write')
		// In the negative control, close while Chokidar is actually polling the pending write.
		// In the owned policy, close after the ordinary input notification.
		await (policy.awaitWriteFinish ? firstPoll.promise : firstChange.promise)
		await watcher.close()
		closed = true
		// An independent writer keeps changing size after the observer has finished closing.
		for (let count = 1; count <= 12; count++) {
			await writeFile(file, 'after-close'.repeat(count))
			await new Promise((resolveWrite) => setTimeout(resolveWrite, 15))
		}
		return {
			filesystemReadsAfterClose,
			pollWatchersAfterClose: process
				.getActiveResourcesInfo()
				.filter((name) => name === 'StatWatcher').length,
		}
	} finally {
		await watcher.close()
		hook.disable()
		await rm(root, { recursive: true, force: true })
	}
}

const awaitWriteFinish = await probe({
	awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 10 },
})
const ownedPolicy = await probe(hostFileWatchOptions())
assert.equal(ownedPolicy.filesystemReadsAfterClose, 0)
assert.equal(ownedPolicy.pollWatchersAfterClose, 0)
console.log(`WATCH_POLICY_EVIDENCE=${JSON.stringify({ awaitWriteFinish, ownedPolicy })}`)
