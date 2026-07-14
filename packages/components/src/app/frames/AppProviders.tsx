import { useComputedColorScheme } from '@mantine/core'
import { ModalsProvider, openConfirmModal } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { Outlet } from '@tanstack/react-router'
import { useMemo, useSyncExternalStore } from 'react'
import {
	createGlobalExtensionContext,
	extensionLocale,
	type ExtensionContext,
	ExtensionPathnameProvider,
	ExtensionProvider,
} from '../../extension'
import { WorkbenchLoader } from '../../workbench/runtime'
import { notifyAndRecord } from '../notifications/notifyBridge'
import { NotificationCenterProvider } from '../notifications/NotificationCenterProvider'
import { usePluginOverview } from '../plugins/pluginOverview'
import { RUNTIME_SECURITY_BASE, useRuntimeTransportClient } from '../../runtime'
import { useCurrentPathname } from '../router/useCurrentRoute'

export function AppProviders() {
	const pathname = useCurrentPathname()
	const isSecurityRoute =
		pathname === RUNTIME_SECURITY_BASE || pathname.startsWith(`${RUNTIME_SECURITY_BASE}/`)
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const pluginOverview = usePluginOverview()
	const runningPluginSignature = (pluginOverview.overview?.status.statuses ?? [])
		.filter((plugin) => plugin.isRunning)
		.map((plugin) => plugin.name)
		.sort((left, right) => left.localeCompare(right))
		.join('\n')
	const runningPlugins = useMemo(
		() => new Set(runningPluginSignature ? runningPluginSignature.split('\n') : []),
		[runningPluginSignature],
	)
	const transportClient = useRuntimeTransportClient()
	const localeSnapshot = useSyncExternalStore(
		extensionLocale.subscribe,
		() => `${extensionLocale.locale}::${extensionLocale.fallbackLocale ?? ''}`,
		() => `${extensionLocale.locale}::${extensionLocale.fallbackLocale ?? ''}`,
	)

	const extensionContext = useMemo<ExtensionContext>(
		() =>
			createGlobalExtensionContext({
				colorScheme,
				runningPlugins,
				runningPluginsReady: pluginOverview.hasSnapshot,
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
		[colorScheme, localeSnapshot, pluginOverview.hasSnapshot, runningPlugins, transportClient],
	)

	return (
		<ExtensionPathnameProvider value={pathname}>
			<ExtensionProvider value={extensionContext}>
				<NotificationCenterProvider>
					<ModalsProvider>
						<Notifications position="top-center" />
						{isSecurityRoute ? (
							<Outlet />
						) : (
							<>
								<WorkbenchLoader />
								<Outlet />
							</>
						)}
					</ModalsProvider>
				</NotificationCenterProvider>
			</ExtensionProvider>
		</ExtensionPathnameProvider>
	)
}
