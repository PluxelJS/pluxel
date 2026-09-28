import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
const mocks = vi.hoisted(() => ({ show: vi.fn<(...args: unknown[]) => string>(() => 'toast-1') }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: mocks.show } }))
import { notifyAndRecord, setNotificationCenterPush } from '../src/app/notifications/notifyBridge'

describe('diagnostic notifications', () => {
	it('keeps failures open and copies the title, message and full diagnostic report', () => {
		const history = vi.fn()
		const cleanup = setNotificationCenterPush(history)
		try {
			notifyAndRecord({
				title: '启动失败',
				message: 'Database aborted',
				color: 'red',
				diagnosticText: 'stack: database.ts:42',
			})
			const payload = mocks.show.mock.calls.at(-1)![0] as unknown as {
				autoClose: boolean
				message: ReactElement<{ copyText: string }>
			}
			expect(payload.autoClose).toBe(false)
			expect(payload.message.props.copyText).toBe(
				'启动失败\n\nDatabase aborted\n\nstack: database.ts:42',
			)
			expect(history).toHaveBeenCalledWith(
				expect.objectContaining({ title: '启动失败', message: 'Database aborted' }),
			)
		} finally {
			cleanup()
		}
	})
})
