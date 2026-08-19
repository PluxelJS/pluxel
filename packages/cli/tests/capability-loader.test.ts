import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadOfficialCapability, OfficialCapabilityError } from '../src/capability-loader'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	)
})

async function createProject(files: Record<string, string>) {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-cli-capability-'))
	temporaryRoots.push(root)
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = resolve(root, relativePath)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, contents, 'utf8')
	}
	return root
}

function projectWithRolldown(params: {
	version?: string
	exports?: Record<string, string>
	files?: Record<string, string>
}) {
	return {
		'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }),
		'node_modules/@pluxel/rolldown/package.json': JSON.stringify({
			name: '@pluxel/rolldown',
			version: params.version ?? '0.1.0',
			type: 'module',
			exports: params.exports ?? {
				'.': './index.mjs',
				'./build': './build.mjs',
			},
		}),
		'node_modules/@pluxel/rolldown/index.mjs': 'export const root = true\n',
		...(params.files ?? {
			'node_modules/@pluxel/rolldown/build.mjs': 'export const marker = "project-owner"\n',
		}),
	}
}

describe('official capability loader', () => {
	it('imports official owners from the project dependency graph', async () => {
		const root = await createProject(projectWithRolldown({}))
		const loaded = await loadOfficialCapability<{ marker: string }>('rolldown-build', {
			cwd: root,
		})

		expect(loaded.marker).toBe('project-owner')
	})

	it('reports missing owners before resolving subpaths', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
			'node_modules/@pluxel/rolldown/package.json': JSON.stringify({
				name: '@pluxel/rolldown',
				version: '0.1.0',
				type: 'module',
				exports: { './not-root': './not-root.mjs' },
			}),
			'node_modules/@pluxel/rolldown/not-root.mjs': 'export const notRoot = true\n',
		})

		const loaded = loadOfficialCapability('rolldown-build', { cwd: root })
		await expect(loaded).rejects.toMatchObject({ code: 'PLUXEL_CAPABILITY_OWNER_MISSING' })
		await expect(loaded).rejects.toBeInstanceOf(OfficialCapabilityError)
	})

	it('accepts workspace protocol peers while running the CLI from source', async () => {
		const root = await createProject(projectWithRolldown({ version: '9.0.0' }))
		const loaded = await loadOfficialCapability<{ marker: string }>('rolldown-build', {
			cwd: root,
		})

		expect(loaded.marker).toBe('project-owner')
	})

	it('separates public subpath errors from owner import failures', async () => {
		const missingSubpath = await createProject(
			projectWithRolldown({ exports: { '.': './index.mjs' }, files: {} }),
		)
		const missingSubpathLoad = loadOfficialCapability('rolldown-database', {
			cwd: missingSubpath,
		})
		await expect(missingSubpathLoad).rejects.toMatchObject({
			code: 'PLUXEL_CAPABILITY_SUBPATH_MISSING',
		})
		await expect(missingSubpathLoad).rejects.toBeInstanceOf(OfficialCapabilityError)

		const importFailure = await createProject(
			projectWithRolldown({
				exports: { '.': './index.mjs', './build': './build.mjs' },
				files: {
					'node_modules/@pluxel/rolldown/build.mjs': 'throw new Error("fixture boom")\n',
				},
			}),
		)
		const failedImport = loadOfficialCapability('rolldown-build', { cwd: importFailure })
		await expect(failedImport).rejects.toMatchObject({ code: 'PLUXEL_CAPABILITY_IMPORT_FAILED' })
		await expect(failedImport).rejects.toBeInstanceOf(OfficialCapabilityError)
	})
})
