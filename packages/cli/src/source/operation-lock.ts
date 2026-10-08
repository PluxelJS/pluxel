import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

/** Own the complete provider graph until every started operation has settled. */
export async function acquireSourceOperationLocks(
	roots: readonly string[],
	operation: 'build' | 'install',
	log: (...args: unknown[]) => void,
): Promise<() => void> {
	const owned: Array<{ path: string; contents: string }> = []
	const release = () => {
		const errors: unknown[] = []
		for (const lock of owned.splice(0).toReversed()) {
			try {
				if (readFileSync(lock.path, 'utf8') !== lock.contents)
					throw new Error(`Source operation lock changed while owned: ${lock.path}`)
				unlinkSync(lock.path)
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0)
			throw new AggregateError(errors, 'Could not release source operation locks')
	}
	try {
		for (const root of [...new Set(roots.map((candidate) => realpathSync(candidate)))].sort()) {
			const directory = resolve(root, '.pluxel')
			mkdirSync(directory, { recursive: true })
			const path = resolve(directory, 'source-operation.lock')
			const contents = JSON.stringify({ pid: process.pid, operation, token: randomUUID() }) + '\n'
			const temporary = `${path}.${randomUUID()}.tmp`
			writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
			let waiting = false
			try {
				for (;;) {
					try {
						// Publish a fully written owner atomically; another process never sees an empty file.
						linkSync(temporary, path)
						owned.push({ path, contents })
						if (waiting) log(`→ Acquired source ${operation} lock: ${root}`)
						break
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
					}
					let owner: unknown
					try {
						owner = JSON.parse(readFileSync(path, 'utf8'))
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
						throw abandonedLock(path, error)
					}
					if (
						!owner ||
						typeof owner !== 'object' ||
						!('pid' in owner) ||
						typeof owner.pid !== 'number' ||
						!Number.isSafeInteger(owner.pid) ||
						owner.pid <= 0
					)
						throw abandonedLock(path)
					try {
						process.kill(owner.pid, 0)
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw abandonedLock(path, error)
					}
					if (!waiting) log(`→ Waiting for source operation owned by PID ${owner.pid}: ${path}`)
					waiting = true
					await setTimeout(200)
				}
			} finally {
				unlinkSync(temporary)
			}
		}
		return release
	} catch (error) {
		try {
			release()
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], 'Source operation lock acquisition failed', {
				cause: releaseError,
			})
		}
		throw error
	}
}

function abandonedLock(path: string, cause?: unknown): Error {
	return new Error(
		`Source operation lock has no verifiable live owner: ${path}. Confirm its previous build/install and child processes have stopped, then remove this lock and retry.`,
		{ cause },
	)
}
