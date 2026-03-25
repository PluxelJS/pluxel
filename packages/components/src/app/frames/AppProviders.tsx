import { useComputedColorScheme } from '@mantine/core'
import { ModalsProvider, openConfirmModal } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { Outlet } from '@tanstack/react-router'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
	createGlobalExtensionContext,
	extensionLocale,
	type ExtensionContext,
	ExtensionPathnameProvider,
	ExtensionProvider,
} from '../../extension'
import { ExtensionLoader } from '../ExtensionLoader'
import { notifyAndRecord } from '../notifications/notifyBridge'
import { NotificationCenterProvider } from '../notifications/NotificationCenterProvider'
import { PluginOverviewProvider } from '../plugins/data'
import { useRuntimeTransportClient } from '../../runtime'
import { useCurrentPathname } from '../router/useCurrentRoute'

export function AppProviders() {
	const pathname = useCurrentPathname()
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const [runningPlugins, setRunningPlugins] = useState<ReadonlySet<string>>(() => new Set())
	const [runningReady, setRunningReady] = useState(false)
	const transportClient = useRuntimeTransportClient()
	const localeSnapshot = useSyncExternalStore(
		extensionLocale.subscribe,
		() => `${extensionLocale.locale}::${extensionLocale.fallbackLocale ?? ''}`,
		() => `${extensionLocale.locale}::${extensionLocale.fallbackLocale ?? ''}`,
	)

	const handleRunningPluginsChange = useCallback((next: ReadonlySet<string>) => {
		setRunningPlugins((prev) => {
			if (prev.size === next.size) {
				let identical = true
				for (const name of prev) {
					if (!next.has(name)) {
						identical = false
						break
					}
				}
				if (identical) {
					return prev
				}
			}
			return new Set(next)
		})
		setRunningReady(true)
	}, [])

	const extensionContext = useMemo<ExtensionContext>(
		() =>
			createGlobalExtensionContext({
				colorScheme,
				runningPlugins,
				runningPluginsReady: runningReady,
				services: {
					transport: transportClient,
					locale: extensionLocale,
					ui: {
						notify: (payload) => {
							const tone = payload?.tone ?? 'info'
							notifyAndRecord({
								title: payload?.title,
								message: payload?.message,
								color:
									tone === 'success'
										? 'green'
										: tone === 'warning'
											? 'yellow'
											: tone === 'error'
												? 'red'
												: 'blue',
							})
						},
						confirm: async (payload) => {
							return new Promise<boolean>((resolve) => {
								openConfirmModal({
									title: payload?.title,
									children: payload?.message,
									labels: {
										confirm: payload?.confirmLabel ?? '确认',
										cancel: payload?.cancelLabel ?? '取消',
									},
									confirmProps: payload?.tone === 'danger' ? { color: 'red' } : undefined,
									onConfirm: () => resolve(true),
									onCancel: () => resolve(false),
									onClose: () => resolve(false),
									closeOnConfirm: true,
								})
							})
						},
					},
				},
			}),
		[colorScheme, localeSnapshot, runningPlugins, runningReady, transportClient],
	)

	return (
		<PluginOverviewProvider>
			<ExtensionPathnameProvider value={pathname}>
				<ExtensionProvider value={extensionContext}>
					<NotificationCenterProvider>
						<ModalsProvider>
							<Notifications position="top-center" />
							<ExtensionLoader
								pollInterval={5000}
								onRunningPluginsChange={handleRunningPluginsChange}
							/>
							<Outlet />
						</ModalsProvider>
					</NotificationCenterProvider>
				</ExtensionProvider>
			</ExtensionPathnameProvider>
		</PluginOverviewProvider>
	)
}
