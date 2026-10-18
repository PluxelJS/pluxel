import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function launch(owner = true) {
	vi.resetModules()
	const backend = Object.assign(new EventEmitter(), {
		postMessage: vi.fn(),
		kill: vi.fn(),
	})
	const decisions: boolean[] = []
	let finished!: () => void
	const closed = new Promise<void>((accept) => {
		finished = accept
	})
	const app = Object.assign(new EventEmitter(), {
		isPackaged: true,
		whenReady: () => Promise.resolve(),
		getPath: () => '/studio-test-profile',
		requestSingleInstanceLock: () => owner,
		quit: vi.fn(() => {
			const event = { preventDefault: vi.fn() }
			app.emit('will-quit', event)
			const prevented = event.preventDefault.mock.calls.length > 0
			decisions.push(prevented)
			if (!prevented) finished()
		}),
	})
	const fork = vi.fn(() => backend)
	vi.doMock('electron', () => ({
		app,
		BrowserWindow: vi.fn(),
		dialog: { showErrorBox: vi.fn() },
		ipcMain: new EventEmitter(),
		MessageChannelMain: vi.fn(),
		net: {},
		protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
		shell: {},
		utilityProcess: { fork },
	}))
	vi.doMock('../src/rpc/message-port.ts', () => ({ createNativeDesktopClient: vi.fn() }))
	await import('../src/electron/main.ts')
	expect(fork).toHaveBeenCalledTimes(owner ? 1 : 0)
	return { app, backend, decisions, closed, fork }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.doUnmock('electron')
	vi.doUnmock('../src/rpc/message-port.ts')
})

describe('Electron backend shutdown', () => {
	it('waits for the backend acknowledgement before the final quit', async () => {
		const { app, backend, decisions, closed } = await launch()
		app.quit()
		try {
			expect(decisions).toEqual([true])
			expect(backend.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'close' }, [])
			expect(backend.kill).not.toHaveBeenCalled()
		} finally {
			backend.emit('message', { type: 'closed' })
			await closed
		}
		expect(decisions).toEqual([true, false])
		expect(backend.kill).toHaveBeenCalledOnce()
	})

	it('prevents repeated quits until the same backend drain completes', async () => {
		const { app, backend, decisions, closed } = await launch()
		app.emit('window-all-closed')
		app.quit()
		try {
			expect(decisions).toEqual([true, true])
			expect(backend.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'close' }, [])
			expect(backend.kill).not.toHaveBeenCalled()
		} finally {
			backend.emit('message', { type: 'closed' })
			await closed
		}
		expect(decisions).toEqual([true, true, false])
	})

	it('reports an exit with code zero before the cleanup acknowledgement', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { app, backend, closed } = await launch()
		app.quit()
		backend.emit('exit', 0)
		await closed
		expect(error).toHaveBeenCalledWith(
			'Studio shutdown failed',
			expect.objectContaining({ message: 'Studio backend exited while closing (0)' }),
		)
	})

	it('reports the backend cleanup failure instead of treating its reply as success', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { app, backend, closed } = await launch()
		app.quit()
		backend.emit('message', { type: 'closed', error: 'Host cleanup failed' })
		await closed
		expect(error).toHaveBeenCalledWith(
			'Studio shutdown failed',
			expect.objectContaining({ message: 'Host cleanup failed' }),
		)
	})

	it('allows a non-owner instance to exit without starting a backend', async () => {
		const { app, fork, decisions } = await launch(false)
		expect(fork).not.toHaveBeenCalled()
		app.quit()
		expect(decisions).toEqual([false, false])
	})
})
