import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { InputStore } from '../src/backend/inputs.js'

it('compares one storage version for raw data and regions and preserves a concurrent winner', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-input-cas-'))
	try {
		const store = new InputStore(root)
		const editor = {
			formatVersion: 1 as const,
			templateId: 'report/report.ts',
			templateRevision: 'source-one',
			regions: {
				body: {
					type: 'doc',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
				},
			},
		}
		expect(await store.get('project', 'report/report.ts')).toEqual({
			data: {},
			storageVersion: null,
		})
		const initial = await store.set('project', 'report/report.ts', {
			data: { raw: ' input ' },
			editor,
			expectedVersion: null,
		})
		const writes = await Promise.allSettled([
			store.set('project', 'report/report.ts', {
				data: { raw: 'first' },
				editor,
				expectedVersion: initial.storageVersion,
			}),
			store.set('project', 'report/report.ts', {
				data: { raw: 'second' },
				editor: { ...editor, regions: { body: { type: 'doc', content: [{ type: 'paragraph' }] } } },
				expectedVersion: initial.storageVersion,
			}),
		])
		expect(writes.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
		expect(writes[1]).toMatchObject({ reason: { code: 'DRAFT_VERSION_CONFLICT' } })
		expect(await store.get('project', 'report/report.ts')).toEqual(
			writes[0].status === 'fulfilled' ? writes[0].value : undefined,
		)
		const current = await store.get('project', 'report/report.ts')
		expect(current.editor?.regions.body).toEqual(editor.regions.body)
		expect(initial.data).toEqual({ raw: ' input ' })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('moves the complete draft on explicit report rename and never repairs malformed saved content', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-input-rename-'))
	try {
		const store = new InputStore(root)
		await store.set('project', 'report/report.ts', {
			data: { raw: ' original ' },
			expectedVersion: null,
			editor: {
				formatVersion: 1,
				templateId: 'report/report.ts',
				templateRevision: 'before',
				regions: { body: { type: 'doc', content: [{ type: 'paragraph' }] } },
			},
		})
		await store.copyEntries('project', [{ from: 'report/report.ts', to: 'renamed/renamed.ts' }], {
			before: 'before',
			after: 'after',
		})
		expect(await store.get('project', 'report/report.ts')).toEqual({
			data: {},
			storageVersion: null,
		})
		expect(await store.get('project', 'renamed/renamed.ts')).toMatchObject({
			data: { raw: ' original ' },
			editor: { templateId: 'renamed/renamed.ts', templateRevision: 'after' },
		})
		await store.removeEntries('project', ['renamed/renamed.ts'])
		expect(await store.get('project', 'renamed/renamed.ts')).toEqual({
			data: {},
			storageVersion: null,
		})
		const path = join(
			root,
			createHash('sha256')
				.update(JSON.stringify(['project', 'broken/broken.ts']))
				.digest('hex') + '.json',
		)
		const invalid = JSON.stringify({ old: 'bare input requires explicit conversion' })
		await writeFile(path, invalid)
		await expect(store.get('project', 'broken/broken.ts')).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		})
		expect(await readFile(path, 'utf8')).toBe(invalid)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
