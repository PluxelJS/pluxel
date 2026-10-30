// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantPanel } from '../src/renderer/assistant'
import type { AiModel, AiSnapshot, AiThread } from '../src/shared/contracts'

const connection = vi.hoisted(() => ({ current: {} as ReturnType<typeof createApi> }))
vi.mock('../src/renderer/api', () => ({
	get api() {
		return connection.current
	},
}))
vi.mock('../src/renderer/provider-settings', () => ({ ProviderSettings: () => null }))

function createApi() {
	return {
		models: vi.fn(async (): Promise<AiModel[]> => []),
		threads: vi.fn(async (): Promise<AiThread[]> => []),
		snapshot: vi.fn(async (): Promise<AiSnapshot> => ({
			threadId: 'thread',
			title: 'Saved thread',
			messages: [],
			running: false,
		})),
		createThread: vi.fn(),
	}
}
function withdrawn() {
	return Object.assign(new Error('Studio backend generation was withdrawn; reconnect'), {
		code: 'BACKEND_UNAVAILABLE',
	})
}
async function mount() {
	await act(async () => {
		render(
			<MantineProvider>
				<AssistantPanel
					projectId="project"
					entries={[]}
					uiState={{ drafts: new Map(), activeThreadId: null }}
					onChanged={() => {}}
				/>
			</MantineProvider>,
		)
	})
}
beforeEach(() => {
	vi.useFakeTimers()
	connection.current = createApi()
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}))
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})
afterEach(() => {
	cleanup()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

it('clears a retired background read notice when the next backend read succeeds', async () => {
	connection.current.threads.mockRejectedValueOnce(withdrawn())
	await mount()
	expect(screen.getByRole('alert')).toBeTruthy()
	connection.current = createApi()
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1000)
	})
	expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['models', 'threads'] as const)(
	'ignores a late %s read failure from the retired API',
	async (method) => {
		let rejectOldRead!: (cause: Error) => void
		connection.current[method].mockImplementationOnce(
			() =>
				new Promise<never>((_resolve, reject) => {
					rejectOldRead = reject
				}),
		)
		await mount()
		connection.current = createApi()
		await act(async () => {
			rejectOldRead(withdrawn())
		})
		expect(screen.queryByRole('alert')).toBeNull()
	},
)

it('preserves an actual AI operation failure across successful background reads', async () => {
	connection.current.createThread.mockRejectedValueOnce(withdrawn())
	await mount()
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: '新建 AI 会话' }))
	})
	expect(screen.getByText('Studio backend generation was withdrawn; reconnect')).toBeTruthy()
	connection.current = createApi()
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1000)
	})
	expect(screen.getByText('Studio backend generation was withdrawn; reconnect')).toBeTruthy()
})

it('clears the conversation read notice when its snapshot recovers', async () => {
	const thread = { id: 'thread', title: 'Saved thread', updatedAt: 1, running: false }
	connection.current.threads.mockResolvedValue([thread])
	connection.current.snapshot.mockRejectedValueOnce(withdrawn())
	await mount()
	expect(screen.getByRole('alert')).toBeTruthy()
	connection.current = createApi()
	connection.current.threads.mockResolvedValue([thread])
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500)
	})
	expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores a late conversation snapshot failure from the retired API', async () => {
	connection.current.threads.mockResolvedValue([
		{ id: 'thread', title: 'Saved thread', updatedAt: 1, running: false },
	])
	let rejectOldRead!: (cause: Error) => void
	connection.current.snapshot.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectOldRead = reject
			}),
	)
	await mount()
	connection.current = createApi()
	await act(async () => {
		rejectOldRead(withdrawn())
	})
	expect(screen.queryByRole('alert')).toBeNull()
})
