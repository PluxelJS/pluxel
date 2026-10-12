import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { rpcError } from './errors.js'

interface RootOwner {
	instanceId: string
	pid: number
	root: string
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// Permission failure and unknown OS errors are not proof that ownership is stale.
		return (error as NodeJS.ErrnoException).code !== 'ESRCH'
	}
}

async function record(path: string): Promise<RootOwner> {
	const stat = await lstat(path)
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
		throw rpcError(
			'ROOT_IN_USE',
			'Studio root ownership cannot be confirmed; preserve the existing lock',
		)
	const value = JSON.parse(await readFile(path, 'utf8')) as RootOwner
	if (
		!value ||
		typeof value.instanceId !== 'string' ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.root !== 'string'
	)
		throw rpcError(
			'ROOT_IN_USE',
			'Studio root ownership cannot be confirmed; preserve the existing lock',
		)
	return value
}

async function absent(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return false
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
		throw error
	}
}

/** Hard-link publication makes an owner record complete before another process observes it. */
export async function acquireStudioRoot(inputRoot: string, instanceId = randomUUID()) {
	await mkdir(resolve(inputRoot), { recursive: true })
	const root = await realpath(resolve(inputRoot))
	const owner: RootOwner = { instanceId, pid: process.pid, root }
	const lock = join(root, '.studio-host.lock')
	const reclamation = join(root, '.studio-host-reclaim.lock')
	const temporary = join(root, `.studio-host-owner-${instanceId}.tmp`)
	await writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
	let ownsLock = false
	let ownsReclamation = false
	const releaseOwned = async (path: string) => {
		try {
			const currentOwner = await record(path)
			if (currentOwner.instanceId === instanceId) await unlink(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
	}
	try {
		if (!(await absent(reclamation)))
			throw rpcError(
				'ROOT_IN_USE',
				'Studio root is being reclaimed; ownership has not been released',
			)
		try {
			await link(temporary, lock)
			ownsLock = true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			let existing: RootOwner
			try {
				existing = await record(lock)
			} catch (cause) {
				throw rpcError(
					'ROOT_IN_USE',
					'Studio root has an unconfirmed ownership record; preserve the existing lock',
					cause,
				)
			}
			if (processAlive(existing.pid))
				throw Object.assign(
					rpcError(
						'ROOT_IN_USE',
						`Studio root is already owned by instance ${existing.instanceId}`,
					),
					{ instanceId: existing.instanceId, root, pid: existing.pid },
				)
			// All starters inspect this fence before and after acquisition. It prevents a stale
			// owner check in another starter from deleting this process's newly published lock.
			try {
				await link(temporary, reclamation)
				ownsReclamation = true
			} catch (cause) {
				throw rpcError('ROOT_IN_USE', 'Another process is confirming stale Studio ownership', cause)
			}
			const confirmed = await record(lock)
			if (
				confirmed.instanceId !== existing.instanceId ||
				confirmed.pid !== existing.pid ||
				processAlive(confirmed.pid)
			)
				throw rpcError('ROOT_IN_USE', 'Studio root ownership changed during stale confirmation')
			await unlink(lock)
			await link(temporary, lock)
			ownsLock = true
		}
		if (!ownsReclamation && !(await absent(reclamation)))
			throw rpcError('ROOT_IN_USE', 'Studio root reclamation began during acquisition')
		if (ownsReclamation) {
			await releaseOwned(reclamation)
			ownsReclamation = false
		}
		await unlink(temporary)
		let released = false
		return {
			root,
			instanceId,
			async release() {
				if (released) return
				released = true
				await releaseOwned(lock)
			},
		}
	} catch (error) {
		if (ownsLock) await releaseOwned(lock)
		if (ownsReclamation) await releaseOwned(reclamation)
		await unlink(temporary).catch(() => {})
		throw error
	}
}
