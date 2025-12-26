import { useLocalStorage } from '@mantine/hooks'
import type React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { setNotificationCenterPush } from './notifyBridge'

export type NotificationRecord = {
	id: string
	title?: string
	message?: string
	color?: string
	createdAt: number
	read: boolean
}

type NotificationInput = {
	id?: string
	title?: string
	message?: string
	color?: string
}

type NotificationCenterContextValue = {
	items: NotificationRecord[]
	unread: number
	push: (input: NotificationInput) => void
	markAllRead: () => void
	clear: () => void
}

const NotificationCenterContext = createContext<NotificationCenterContextValue | null>(null)

const genId = () =>
	globalThis.crypto?.randomUUID?.() ??
	`n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const STORAGE_KEY = 'pluxel:notifications-history'
const MAX_HISTORY = 50

export function NotificationCenterProvider({ children }: { children: React.ReactNode }) {
	const [items, setItems] = useLocalStorage<NotificationRecord[]>({
		key: STORAGE_KEY,
		defaultValue: [],
		getInitialValueInEffect: true,
	})

	const push = useCallback(
		(input: NotificationInput) => {
			setItems((prev) => {
				const next: NotificationRecord = {
					id: input.id ?? genId(),
					title: input.title,
					message: input.message,
					color: input.color,
					createdAt: Date.now(),
					read: false,
				}
				const merged = [next, ...prev]
				return merged.slice(0, MAX_HISTORY)
			})
		},
		[setItems],
	)

	const markAllRead = useCallback(() => {
		setItems((prev) => prev.map((item) => ({ ...item, read: true })))
	}, [setItems])

	const clear = useCallback(() => setItems([]), [setItems])

	const unread = useMemo(() => items.filter((item) => !item.read).length, [items])

	const value = useMemo(
		() => ({
			items,
			unread,
			push,
			markAllRead,
			clear,
		}),
		[items, unread, push, markAllRead, clear],
	)

	useEffect(() => {
		return setNotificationCenterPush(push)
	}, [push])

	return (
		<NotificationCenterContext.Provider value={value}>
			{children}
		</NotificationCenterContext.Provider>
	)
}

export function useNotificationCenter() {
	const ctx = useContext(NotificationCenterContext)
	if (!ctx) throw new Error('useNotificationCenter must be used within NotificationCenterProvider')
	return ctx
}
