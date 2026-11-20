import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readHostPluginStatusOverview, readHostRecentUpdates } from '@pluxel/host/internal'
import { openWorkbenchFixture } from './workbench-fixture.mts'

const fixtureRoot = process.env.PLUXEL_WORKBENCH_HMR_ROOT!
const root = resolve(fixtureRoot, 'app')
const outsideRoot = resolve(fixtureRoot, 'external')
await mkdir(root, { recursive: true })
await mkdir(outsideRoot, { recursive: true })
const { server, currentHost, assertRunningVersion, eventually } = await openWorkbenchFixture(root)
try {
	await eventually(() => assertRunningVersion('initial'))
	const ownerPath = resolve(root, 'src/index.ts')
	const ownerSource = await readFile(ownerPath, 'utf8')
	const withHelper = (specifier: string) =>
		`import { helperVersion } from '${specifier}'\n` +
		ownerSource.replace('readonly version = version', 'readonly version = helperVersion')
	const expectRejected = async (change: () => Promise<unknown>, marker: string) => {
		const previous = readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.sequence
		await change()
		await eventually(() => {
			const latest = readHostRecentUpdates(currentHost().ctx)?.latestUpdate()
			assert.equal(latest?.state, 'settled')
			assert.equal(latest?.outcome, 'retained-previous')
			assert.notEqual(latest?.sequence, previous, marker)
		})
	}
	// The new module is absent from the committed closure. Fixing only it must retry the application.
	await writeFile(
		resolve(root, 'src/new-helper.ts'),
		"throw new Error('NEW_HELPER_BROKEN'); export const helperVersion = 'broken'\n",
	)
	await delay(200)
	await expectRejected(() => writeFile(ownerPath, withHelper('./new-helper')), 'NEW_HELPER_BROKEN')
	await assertRunningVersion('initial')
	const evaluationError = readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.error
	assert.match(evaluationError?.message ?? '', /NEW_HELPER_BROKEN/)
	assert.match(evaluationError?.file ?? '', /new-helper\.ts$/)
	assert.ok(evaluationError?.importChain.some((file) => file.endsWith('src/index.ts')))
	assert.ok(evaluationError?.importChain.some((file) => file.endsWith('new-helper.ts')))
	await writeFile(
		resolve(root, 'src/new-helper.ts'),
		"export const helperVersion = 'helper-fixed'\n",
	)
	await eventually(() => assertRunningVersion('helper-fixed'))

	// An unresolved import has no graph node. Creation must recover through its observed importer.
	await expectRejected(() => writeFile(ownerPath, withHelper('./missing-helper')), 'missing-helper')
	await assertRunningVersion('helper-fixed')
	const missingError = readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.error
	assert.ok(missingError?.importChain.some((file) => file.endsWith('src/index.ts')))
	assert.match(JSON.stringify(missingError), /missing-helper/)
	await writeFile(
		resolve(root, 'src/missing-helper.ts'),
		"export const helperVersion = 'created-helper'\n",
	)
	await eventually(() => assertRunningVersion('created-helper'))

	// ESM TypeScript uses .js import spellings even when the source file is .ts.
	await expectRejected(() => writeFile(ownerPath, withHelper('./esm-helper.js')), 'esm-helper.js')
	await assertRunningVersion('created-helper')
	await writeFile(
		resolve(root, 'src/esm-helper.ts'),
		"export const helperVersion = 'esm-created'\n",
	)
	await eventually(() => assertRunningVersion('esm-created'))

	// Creating a package manifest can resolve a missing directory import outside Vite's root.
	await writeFile(
		resolve(outsideRoot, 'value.js'),
		"export const helperVersion = 'outside-manifest-fixed'\n",
	)
	await expectRejected(
		() => writeFile(ownerPath, withHelper(relative(dirname(ownerPath), outsideRoot))),
		'outside package',
	)
	await assertRunningVersion('esm-created')
	await writeFile(
		resolve(outsideRoot, 'package.json'),
		JSON.stringify({ type: 'module', exports: './value.js' }),
	)
	await eventually(() => assertRunningVersion('outside-manifest-fixed'))

	// node_modules is ignored by Vite's default watcher. Completing an installation must still retry.
	await expectRejected(
		() => writeFile(ownerPath, withHelper('hmr-recovery-package')),
		'hmr-recovery-package',
	)
	await assertRunningVersion('outside-manifest-fixed')
	const packageRoot = resolve(root, 'node_modules/hmr-recovery-package')
	await mkdir(packageRoot, { recursive: true })
	await writeFile(
		resolve(packageRoot, 'package.json'),
		JSON.stringify({ name: 'hmr-recovery-package', type: 'module', exports: './index.js' }),
	)
	await writeFile(
		resolve(packageRoot, 'index.js'),
		"export const helperVersion = 'installed-package'\n",
	)
	await eventually(() => assertRunningVersion('installed-package'))

	// Repairing package metadata must invalidate Vite's own package resolution cache as well.
	const brokenPackage = resolve(root, 'node_modules/hmr-manifest-package')
	await mkdir(brokenPackage, { recursive: true })
	await writeFile(
		resolve(brokenPackage, 'package.json'),
		JSON.stringify({ name: 'hmr-manifest-package', type: 'module', exports: './missing.js' }),
	)
	await writeFile(
		resolve(brokenPackage, 'index.js'),
		"export const helperVersion = 'manifest-fixed'\n",
	)
	await expectRejected(
		() => writeFile(ownerPath, withHelper('hmr-manifest-package')),
		'hmr-manifest-package',
	)
	await assertRunningVersion('installed-package')
	await writeFile(
		resolve(brokenPackage, 'package.json'),
		JSON.stringify({ name: 'hmr-manifest-package', type: 'module', exports: './index.js' }),
	)
	await eventually(() => assertRunningVersion('manifest-fixed'))

	// Once accepted, abandoned failed candidates cannot keep admitting unrelated updates.
	const previousSequence = readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.sequence
	await writeFile(ownerPath, ownerSource)
	let sequence: number | undefined
	await eventually(async () => {
		await assertRunningVersion('initial')
		// Running instances precede route settlement and retirement of the previous watches.
		const latest = readHostRecentUpdates(currentHost().ctx)?.latestUpdate()
		assert.equal(latest?.state, 'settled')
		assert.equal(latest?.outcome, 'applied')
		assert.notEqual(latest?.sequence, previousSequence)
		assert.equal(latest?.trigger, relative(root, ownerPath).replaceAll('\\', '/'))
		const settled = await readHostPluginStatusOverview(currentHost().ctx)
		assert.equal(settled.statuses[0]?.recentUpdate?.batch.sequence, latest?.sequence)
		sequence = latest?.sequence
	})
	assert.ok(sequence !== undefined)
	await writeFile(resolve(root, 'src/new-helper.ts'), "throw new Error('ABANDONED_HELPER')\n")
	await delay(400)
	await assertRunningVersion('initial')
	const afterAbandonedUpdate = await readHostPluginStatusOverview(currentHost().ctx)
	assert.equal(afterAbandonedUpdate.statuses[0]?.recentUpdate?.batch.sequence, sequence)
	assert.equal(readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.sequence, sequence)
} finally {
	await server.close()
}
