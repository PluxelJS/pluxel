import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
	createTypstSourceProject,
	TypstSourceProjectError,
	type TypstSourceFiles,
} from '../src/source/node.js'
import { typstSourceLibrary } from '../src/source/library.js'
import { completeSourcePaths } from '../src/tiptap/source-paths.js'

const bytes = (text: string) => new TextEncoder().encode(text).length

describe('source project file creation', () => {
	it('creates an empty file as one transaction without discarding earlier edits', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': 'Original' } })
		const changed = vi.fn()
		project.subscribe(changed)
		expect(
			project.apply({
				baseRevision: 0,
				patches: [{ path: 'main.typ', from: 0, to: 8, text: 'Edited' }],
			}).ok,
		).toBe(true)
		expect(
			project.createFile({ baseRevision: 1, path: 'sections/new.typ', contents: '' }),
		).toMatchObject({ ok: true, value: { revision: 2 } })
		expect(project.open('sections/new.typ').source).toBe('')
		expect(project.snapshot().files).toEqual({ 'main.typ': 'Edited', 'sections/new.typ': '' })
		expect(changed).toHaveBeenCalledTimes(2)
		expect(project.undo()).toMatchObject({ ok: true, value: { revision: 3 } })
		expect(project.snapshot().files).toEqual({ 'main.typ': 'Edited' })
		expect(() => project.open('sections/new.typ')).toThrow(TypstSourceProjectError)
		expect(project.canUndo).toBe(true)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files).toEqual({ 'main.typ': 'Original' })
		expect(project.canUndo).toBe(false)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files).toEqual({ 'main.typ': 'Edited' })
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files).toEqual({ 'main.typ': 'Edited', 'sections/new.typ': '' })
		expect(project.canRedo).toBe(false)
	})

	it('makes only the new file writable even when every existing file is read-only', () => {
		const project = createTypstSourceProject({
			files: { 'main.typ': 'Read-only' },
			writablePaths: [],
		})
		const observed: boolean[] = []
		project.subscribe(() => observed.push(project.isWritable('chapter.typ')))
		expect(project.createFile({ baseRevision: 0, path: 'chapter.typ', contents: 'New' }).ok).toBe(
			true,
		)
		expect(observed).toEqual([true])
		expect(project.isWritable('main.typ')).toBe(false)
		expect(
			project.apply({
				baseRevision: 1,
				patches: [{ path: 'main.typ', from: 0, to: 0, text: 'Changed' }],
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'READ_ONLY' }] })
		expect(
			project.apply({
				baseRevision: 1,
				patches: [{ path: 'chapter.typ', from: 0, to: 3, text: 'Edited' }],
			}).ok,
		).toBe(true)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files['chapter.typ']).toBe('New')
		expect(project.undo().ok).toBe(true)
		expect(project.isWritable('chapter.typ')).toBe(false)
		expect(project.redo().ok).toBe(true)
		expect(project.isWritable('chapter.typ')).toBe(true)
		expect(project.isWritable('main.typ')).toBe(false)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files['chapter.typ']).toBe('Edited')
	})

	it('rejects stale revisions, overwrites, invalid paths and invalid text without changing history', () => {
		const project = createTypstSourceProject({
			files: { 'main.typ': 'Original', resource: 'A file', 'sections/existing.typ': '' },
		})
		expect(project.createFile({ baseRevision: 0, path: 'draft.typ', contents: '' }).ok).toBe(true)
		expect(project.undo().ok).toBe(true)
		const baseline = project.snapshot()
		const changed = vi.fn()
		project.subscribe(changed)
		expect(project.createFile({ baseRevision: 0, path: 'new.typ', contents: '' })).toMatchObject({
			ok: false,
			issues: [{ code: 'CONFLICT' }],
		})
		expect(
			project.createFile({ baseRevision: 2, path: 'main.typ', contents: 'Overwrite' }),
		).toMatchObject({ ok: false, issues: [{ code: 'CONFLICT', path: 'main.typ' }] })
		for (const path of [
			'',
			'/absolute.typ',
			'../outside.typ',
			'./relative.typ',
			'a//b.typ',
			'a/',
			'a\\b.typ',
			'a\0b.typ',
			'resource/child.typ',
			'sections',
		]) {
			expect(project.createFile({ baseRevision: 2, path, contents: '' })).toMatchObject({
				ok: false,
				issues: [{ code: 'INVALID_PATH' }],
			})
		}
		for (const contents of ['\ud800', 12, null]) {
			expect(
				project.createFile({ baseRevision: 2, path: 'new.typ', contents: contents as string }),
			).toMatchObject({ ok: false, issues: [{ code: 'INVALID_SOURCE' }] })
		}
		expect(project.snapshot()).toEqual(baseline)
		expect(changed).not.toHaveBeenCalled()
		expect(project.canUndo).toBe(false)
		expect(project.canRedo).toBe(true)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files['draft.typ']).toBe('')
	})

	it('detaches binary input and snapshots, including Buffer input and prototype-like filenames', () => {
		const project = createTypstSourceProject({ files: {} })
		const contents = Buffer.from([0, 255, 23])
		const result = project.createFile({ baseRevision: 0, path: '__proto__', contents })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('File creation failed')
		contents.fill(1)
		const returned = result.value.files['__proto__'] as Uint8Array
		returned.fill(2)
		expect(project.snapshot().files['__proto__']).toEqual(Uint8Array.from([0, 255, 23]))
		expect(project.undo().ok).toBe(true)
		expect(Object.keys(project.snapshot().files)).toEqual([])
		expect(project.redo().ok).toBe(true)
		expect(Object.keys(project.snapshot().files)).toEqual(['__proto__'])
		expect(project.snapshot().files['__proto__']).toEqual(Uint8Array.from([0, 255, 23]))
		expect(() => project.open('__proto__')).toThrow('file is not valid UTF-8 text')
	})

	it('accepts invalid Typst drafts without claiming they compile', () => {
		const project = createTypstSourceProject({ files: {} })
		const contents = '#text[unfinished'
		expect(project.createFile({ baseRevision: 0, path: 'draft.typ', contents }).ok).toBe(true)
		expect(project.snapshot().files['draft.typ']).toBe(contents)
		expect(project.open('draft.typ').editable).toBe(false)
		expect(project.diagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'SYNTAX_ERROR', path: 'draft.typ' }),
			]),
		)
	})

	it('refreshes cached imports, project labels and path completion on creation, undo and redo', () => {
		const project = createTypstSourceProject({
			files: {
				'main.typ':
					'#import "lib/pluxel.typ" as report\n#report.reference(<sec:target>, caption: true)',
			},
		})
		const paths = () => Object.keys(project.snapshot().files)
		expect(project.open('main.typ').references).toEqual([])
		expect(completeSourcePaths(paths(), 'main.typ', 'lib/pl')).toEqual([])
		expect(
			project.createFile({ baseRevision: 0, path: 'lib/pluxel.typ', contents: typstSourceLibrary })
				.ok,
		).toBe(true)
		expect(project.open('main.typ').references).toEqual([
			expect.objectContaining({ label: 'sec:target' }),
		])
		expect(completeSourcePaths(paths(), 'main.typ', 'lib/pl')).toEqual([
			{
				value: 'lib/pluxel.typ',
				label: 'pluxel.typ',
				directory: false,
			},
		])
		expect(project.undo().ok).toBe(true)
		expect(project.open('main.typ').references).toEqual([])
		expect(completeSourcePaths(paths(), 'main.typ', 'lib/pl')).toEqual([])
		expect(project.redo().ok).toBe(true)
		expect(project.open('main.typ').references).toHaveLength(1)
		expect(
			project.createFile({
				baseRevision: project.revision,
				path: 'sections/target.typ',
				contents: '= Target <sec:target>\n',
			}).ok,
		).toBe(true)
		expect(project.diagnostics().filter((issue) => issue.code === 'UNRESOLVED_REFERENCE')).toEqual(
			[],
		)
		expect(project.undo().ok).toBe(true)
		expect(project.diagnostics()).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'UNRESOLVED_REFERENCE' })]),
		)
	})

	it('creates files and patches their include and directory in one history item', () => {
		const initial = {
			'main.typ': '// Original\r\n',
			'data/chapters.json': '[]\n',
			'lib/layout.typ': '#let fixed = true\n',
		}
		const project = createTypstSourceProject({
			files: initial,
			writablePaths: ['main.typ', 'data/chapters.json'],
		})
		const changed = vi.fn()
		project.subscribe(changed)
		expect(
			project.apply({
				baseRevision: 0,
				patches: [{ path: 'main.typ', from: 0, to: 0, text: '// Earlier edit\r\n' }],
			}).ok,
		).toBe(true)
		const prior = project.snapshot()
		const main = prior.files['main.typ'] as string
		const binary = Buffer.from([0, 255, 23])
		const createFiles = {
			'sections/new.typ': '= 新章节\n\n完整正文。\n',
			'assets/data.bin': binary,
		}
		const include = '#include "sections/new.typ"\r\n'
		const directory = '["sections/new.typ"]\n'
		expect(
			project.apply({
				baseRevision: prior.revision,
				createFiles,
				patches: [
					{ path: 'main.typ', from: bytes(main), to: bytes(main), text: include },
					{
						path: 'data/chapters.json',
						from: 0,
						to: bytes(initial['data/chapters.json']),
						text: directory,
					},
				],
			}),
		).toMatchObject({ ok: true, value: { revision: 2 } })
		const expected = {
			...prior.files,
			'main.typ': main + include,
			'data/chapters.json': directory,
			'sections/new.typ': createFiles['sections/new.typ'],
			'assets/data.bin': Uint8Array.of(0, 255, 23),
		}
		binary.fill(7)
		createFiles['sections/new.typ'] = 'Changed input'
		expect(project.snapshot().files).toEqual(expected)
		expect(project.isWritable('sections/new.typ')).toBe(true)
		expect(project.isWritable('assets/data.bin')).toBe(true)
		expect(project.isWritable('lib/layout.typ')).toBe(false)
		expect(changed).toHaveBeenCalledTimes(2)
		expect(project.undo()).toMatchObject({ ok: true, value: { revision: 3, files: prior.files } })
		expect(project.snapshot().files).toEqual(prior.files)
		expect(project.isWritable('sections/new.typ')).toBe(false)
		expect(project.canUndo).toBe(true)
		expect(changed).toHaveBeenCalledTimes(3)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(initial)
		expect(project.canUndo).toBe(false)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(prior.files)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(expected)
		expect(project.isWritable('sections/new.typ')).toBe(true)
		expect(project.isWritable('lib/layout.typ')).toBe(false)
		expect(project.canRedo).toBe(false)
	})

	it('rejects the entire creation when an existing-file patch fails, preserving redo and permissions', () => {
		const project = createTypstSourceProject({
			files: { 'main.typ': '甲😀乙', 'data/chapters.json': '[]', 'lib/fixed.typ': 'Read-only' },
			writablePaths: ['main.typ', 'data/chapters.json'],
		})
		expect(project.createFile({ baseRevision: 0, path: 'draft.typ', contents: '' }).ok).toBe(true)
		expect(project.undo().ok).toBe(true)
		const baseline = project.snapshot()
		const changed = vi.fn()
		project.subscribe(changed)
		for (const { patch, code } of [
			{ patch: { path: 'main.typ', from: 4, to: 7, text: 'x' }, code: 'INVALID_PATCH' },
			{ patch: { path: 'lib/fixed.typ', from: 0, to: 0, text: 'x' }, code: 'READ_ONLY' },
			{ patch: { path: 'sections/new.typ', from: 0, to: 0, text: 'x' }, code: 'NOT_FOUND' },
		]) {
			expect(
				project.apply({
					baseRevision: baseline.revision,
					createFiles: { 'sections/new.typ': '= 新章节\n' },
					patches: [
						{ path: 'data/chapters.json', from: 0, to: 2, text: '["sections/new.typ"]' },
						patch,
					],
				}),
			).toMatchObject({ ok: false, issues: [{ code }] })
			expect(project.snapshot()).toEqual(baseline)
			expect(project.isWritable('sections/new.typ')).toBe(false)
			expect(project.isWritable('lib/fixed.typ')).toBe(false)
			expect(project.canUndo).toBe(false)
			expect(project.canRedo).toBe(true)
		}
		expect(
			project.apply({ baseRevision: baseline.revision, patches: [], createFiles: {} }),
		).toMatchObject({
			ok: true,
			value: baseline,
		})
		expect(changed).not.toHaveBeenCalled()
		expect(project.canRedo).toBe(true)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files['draft.typ']).toBe('')
	})

	it('rejects every patch when creation conflicts or has invalid input', () => {
		const project = createTypstSourceProject({
			files: { 'main.typ': 'Original', 'sections/old.typ': 'Existing' },
		})
		expect(project.createFile({ baseRevision: 0, path: 'draft.typ', contents: '' }).ok).toBe(true)
		expect(project.undo().ok).toBe(true)
		const baseline = project.snapshot()
		const changed = vi.fn()
		project.subscribe(changed)
		const patches = [{ path: 'main.typ', from: 0, to: 8, text: 'Would change' }]
		for (const { createFiles, code } of [
			{ createFiles: { 'sections/new.typ': '', 'main.typ': 'Overwrite' }, code: 'CONFLICT' },
			{ createFiles: { 'sections/new.typ': '', '../outside.typ': '' }, code: 'INVALID_PATH' },
			{ createFiles: { 'main.typ/child.typ': '' }, code: 'INVALID_PATH' },
			{ createFiles: { sections: '' }, code: 'INVALID_PATH' },
			{ createFiles: { folder: '', 'folder/child.typ': '' }, code: 'INVALID_PATH' },
			{
				createFiles: { 'sections/new.typ': '', 'sections/bad.typ': '\ud800' },
				code: 'INVALID_SOURCE',
			},
			{ createFiles: null, code: 'INVALID_SOURCE' },
			{ createFiles: [], code: 'INVALID_SOURCE' },
		]) {
			expect(
				project.apply({
					baseRevision: baseline.revision,
					patches,
					createFiles: createFiles as TypstSourceFiles,
				}),
			).toMatchObject({ ok: false, issues: [{ code }] })
			expect(project.snapshot()).toEqual(baseline)
			expect(project.isWritable('sections/new.typ')).toBe(false)
			expect(project.canUndo).toBe(false)
			expect(project.canRedo).toBe(true)
		}
		expect(
			project.apply({ baseRevision: 0, patches, createFiles: { 'sections/new.typ': '' } }),
		).toMatchObject({ ok: false, issues: [{ code: 'CONFLICT' }] })
		expect(changed).not.toHaveBeenCalled()
		expect(project.snapshot()).toEqual(baseline)
		expect(project.redo().ok).toBe(true)
		expect(project.snapshot().files['draft.typ']).toBe('')
	})
})
