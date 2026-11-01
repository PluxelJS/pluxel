import { basename, dirname, join } from 'pathe'
import type { FsPromises } from './service'

/** Commit one complete file by replacing it with a closed, same-directory temporary file. */
export async function writeFileAtomic(
	fs: FsPromises,
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const directory = dirname(path)
	await fs.mkdir(directory, { recursive: true })
	const temporary = join(directory, `.tmp.${basename(path)}.${crypto.randomUUID()}`)
	let created = false
	try {
		{
			await using handle = await fs.open(temporary, 'wx', 0o600)
			created = true
			await handle.writeFile(content)
		}
		await fs.rename(temporary, path)
	} catch (cause) {
		const errors = [cause]
		if (created) {
			try {
				await fs.unlink(temporary)
			} catch (cleanup) {
				if (
					!(
						cleanup &&
						typeof cleanup === 'object' &&
						'code' in cleanup &&
						cleanup.code === 'ENOENT'
					)
				)
					errors.push(cleanup)
			}
		}
		if (errors.length > 1)
			throw new AggregateError(errors, `Failed to save and remove temporary file: ${path}`, {
				cause,
			})
		throw cause
	}
}
