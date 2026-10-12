import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompileResult } from '../src/shared/contracts'
import { WorkspaceController } from '../src/renderer/workspace'
import { api } from '../src/renderer/api'
vi.mock('../src/renderer/api', () => ({ api: vi.fn(), ApiError: class extends Error {} }))
const result = (title: string): CompileResult => ({
	projectId: 'project',
	entry: 'main/main.ts',
	name: 'Main',
	template: 'main/main.typ',
	revision: title,
	fields: [],
	data: { title },
	sourceVersions: {},
	preview: {
		sessionId: 'session',
		revision: 1,
		format: 'vector',
		compilerVersion: '0.7.0',
		data: [],
		navigation: { pages: [], points: [], outline: [] },
	},
	diagnostics: [],
	elapsedMs: 1,
})
afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})
describe('workspace external form input', () => {
	it('saves outside files, serializes edits and ignores stale preview data', async () => {
		vi.useFakeTimers()
		const calls: { path: string; body?: unknown }[] = []
		let release: ((value: CompileResult) => void) | undefined
		vi.mocked(api).mockImplementation(async (path, options) => {
			calls.push({ path, body: options?.body })
			if (path.endsWith('/compile'))
				return new Promise<CompileResult>((resolve) => {
					release = resolve
				}) as never
			return { data: {} } as never
		})
		const workspace = new WorkspaceController({ id: 'project', name: 'Project', root: '/project' })
		workspace.ensureDocument('main/main.ts')
		await workspace.writeData('main/main.ts', { title: 'first' })
		release!(result('stale'))
		await Promise.resolve()
		await Promise.resolve()
		expect(workspace.documents.get('main/main.ts')?.data.title).toBe('first')
		await workspace.writeData('main/main.ts', { title: 'latest' })
		await vi.advanceTimersByTimeAsync(400)
		expect(calls.filter((call) => call.path.includes('/input?'))).toEqual([
			{
				path: '/api/projects/project/input?entry=main%2Fmain.ts',
				body: { data: { title: 'latest' } },
			},
		])
		expect(calls.some((call) => call.path.endsWith('/file'))).toBe(false)
		release!(result('latest'))
		await Promise.resolve()
		await Promise.resolve()
		expect(workspace.documents.get('main/main.ts')?.inputDirty).toBeFalsy()
		workspace.dispose()
	})
	it('retains failed input for an explicit retry', async () => {
		vi.useFakeTimers()
		vi.mocked(api).mockImplementation(async (path) => {
			if (path.includes('/input?')) throw new Error('disk full')
			return result('default') as never
		})
		const workspace = new WorkspaceController({ id: 'project', name: 'Project', root: '/project' })
		workspace.ensureDocument('main/main.ts')
		await Promise.resolve()
		await Promise.resolve()
		await workspace.writeData('main/main.ts', { title: 'unsaved' })
		await vi.advanceTimersByTimeAsync(400)
		expect(workspace.documents.get('main/main.ts')).toMatchObject({
			inputDirty: true,
			data: { title: 'unsaved' },
			inputError: expect.stringContaining('disk full'),
		})
		workspace.dispose()
	})
})
