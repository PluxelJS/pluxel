import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement, type ReactNode } from 'react'
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

	it('copies full diagnostics while preserving rich content and its undo action', () => {
		const undo = vi.fn()
		const undoButton = createElement('button', { type: 'button', onClick: undo }, '恢复原策略')
		const message = createElement('div', null, '2 个 Plugin 的策略已更新', undoButton)
		const receipt = {
			ok: true,
			status: 'applied',
			results: [{ address: 'first', report: 'committed' }],
		}
		const diagnosticText = JSON.stringify(receipt, null, 2)

		notifyAndRecord({ title: '已批量关闭自动启动', message, color: 'green', diagnosticText })

		const payload = mocks.show.mock.calls.at(-1)![0] as {
			message: ReactElement<{ message: ReactNode; copyText: string }>
		}
		expect(payload.message.props.copyText).toBe(`已批量关闭自动启动\n\n${diagnosticText}`)
		expect(payload.message.props.message).toBe(message)
		expect(message.props.children).toEqual(['2 个 Plugin 的策略已更新', undoButton])
		undoButton.props.onClick()
		expect(undo).toHaveBeenCalledOnce()
	})

	it('keeps rich notifications without diagnostics in their original form', () => {
		const message = createElement('div', null, '操作完成', createElement('button', null, '撤销'))

		notifyAndRecord({ title: '已完成', message, color: 'green' })

		const payload = mocks.show.mock.calls.at(-1)![0] as { message: ReactNode }
		expect(payload.message).toBe(message)
	})
})
