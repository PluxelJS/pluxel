import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDailyTimeRotatingFileSink } from '../../src/logging/file'

it('uses the upstream formatter for bigint and circular values and flushes on disposal', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-log-values-'))
	try {
		const sink = createDailyTimeRotatingFileSink(join(directory, 'app.log'))
		const value: { count: bigint; self?: unknown } = { count: 2n }
		value.self = value
		try {
			sink({
				category: ['audit'],
				level: 'info',
				timestamp: Date.now(),
				message: ['value ', value],
				rawMessage: 'value {value}',
				properties: { value },
			})
		} finally {
			sink[Symbol.dispose]()
		}
		const files = await readdir(directory)
		expect(files).toHaveLength(1)
		const output = await readFile(join(directory, files[0]!), 'utf8')
		expect(output).toContain('2n')
		expect(output).toContain('Circular')
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
