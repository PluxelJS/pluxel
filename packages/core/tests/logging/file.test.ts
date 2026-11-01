import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getTimeRotatingFileSink } from '@logtape/file'
import { logtape } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'

it('uses the upstream formatter for bigint and circular values and flushes on disposal', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-log-values-'))
	try {
		const sink = getTimeRotatingFileSink({
			directory,
			filename: () => 'native.log',
			interval: 'hourly',
		})
		const host = await createHost({
			plugins: [],
			config: {
				logger: logtape({
					sinks: { file: sink },
					loggers: [{ category: ['pluxel', 'runtime'], sinks: ['file'] }],
				}),
			},
			services: [],
		})
		const value: { count: bigint; self?: unknown } = { count: 2n }
		value.self = value
		try {
			host.ctx.logger.info('value {value}', { value })
		} finally {
			await host.close()
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
