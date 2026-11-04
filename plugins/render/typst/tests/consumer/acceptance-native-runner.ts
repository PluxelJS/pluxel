import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost } from '@pluxel/host'
import { nodeModules } from '@pluxel/services/node'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { ArtifactConsumer, job } from './acceptance-native.js'
const packageRoot = dirname(fileURLToPath(import.meta.resolve('@pluxel/plugin-typst/package.json')))
const host = await createHost({
	plugins: [FontsPlugin, TypstPlugin, ArtifactConsumer],
	services: [nodeModules({ root: join(packageRoot, 'dist/artifacts/node') })],
	config: {
		records: [
			{
				owner: FontsPlugin.nodeAddress(),
				config: { files: [job.font], maxFontBytes: 32 * 1024 * 1024 },
			},
			{ owner: TypstPlugin.nodeAddress(), config: { maxTemplateBytes: 128 * 1024 * 1024 } },
		],
	},
	policy: { autoStart: [ArtifactConsumer.nodeAddress()] },
})
try {
	await mkdir(job.evidence, { recursive: true })
	const report = await host.start()
	assert.equal(report.reconciliation.length, 0, JSON.stringify(report))
	if (report.core.status === 'committed')
		assert.equal(report.core.summary.lifecycleReport.ok, true, JSON.stringify(report))
} finally {
	await host.close()
}
