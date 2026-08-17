import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
	loadOfficialCapability,
	OfficialCapabilityError,
	type OfficialCapabilityErrorCode,
} from '../src/capability-loader'

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

async function expectCapabilityCode(
	run: () => Promise<unknown>,
	code: OfficialCapabilityErrorCode,
) {
	await expect(run()).rejects.toMatchObject({ code })
	await expect(run()).rejects.toBeInstanceOf(OfficialCapabilityError)
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

		await expectCapabilityCode(
			() => loadOfficialCapability('rolldown-build', { cwd: root }),
			'PLUXEL_CAPABILITY_OWNER_MISSING',
		)
	})

	it('checks owner versions against CLI optional peers before import', async () => {
		const root = await createProject(projectWithRolldown({ version: '9.0.0' }))

		await expectCapabilityCode(
			() => loadOfficialCapability('rolldown-build', { cwd: root }),
			'PLUXEL_CAPABILITY_OWNER_INCOMPATIBLE',
		)
	})

	it('separates public subpath errors from owner import failures', async () => {
		const missingSubpath = await createProject(
			projectWithRolldown({ exports: { '.': './index.mjs' }, files: {} }),
		)
		await expectCapabilityCode(
			() => loadOfficialCapability('rolldown-database', { cwd: missingSubpath }),
			'PLUXEL_CAPABILITY_SUBPATH_MISSING',
		)

		const importFailure = await createProject(
			projectWithRolldown({
				exports: { '.': './index.mjs', './build': './build.mjs' },
				files: {
					'node_modules/@pluxel/rolldown/build.mjs': 'throw new Error("fixture boom")\n',
				},
			}),
		)
		await expectCapabilityCode(
			() => loadOfficialCapability('rolldown-build', { cwd: importFailure }),
			'PLUXEL_CAPABILITY_IMPORT_FAILED',
		)
	})
})
