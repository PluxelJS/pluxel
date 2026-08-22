import { useComputedColorScheme } from '@mantine/core'
import { pluginNodeIndexKey } from '@pluxel/core'
import { ModalsProvider, openConfirmModal } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { Outlet } from '@tanstack/react-router'
import { useMemo, useSyncExternalStore } from 'react'
import { workbenchLocale } from '../../workbench/locale'
import { WorkbenchRuntimeProvider, type WorkbenchBrowserHost } from '../../workbench/runtime'
import { notifyAndRecord } from '../notifications/notifyBridge'
import { NotificationCenterProvider } from '../notifications/NotificationCenterProvider'
import { usePluginOverview } from '../plugins/pluginOverview'
import { RUNTIME_SECURITY_BASE, useRuntimeTransportClient } from '../../runtime'
import { useCurrentPathname } from '../router/useCurrentRoute'

export function AppProviders() {
	const pathname = useCurrentPathname()
	const workbenchActive =
		pathname !== RUNTIME_SECURITY_BASE && !pathname.startsWith(`${RUNTIME_SECURITY_BASE}/`)
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const pluginOverview = usePluginOverview()
	const runningPluginSignature = (pluginOverview.overview?.status.statuses ?? [])
		.filter((plugin) => plugin.isRunning)
		.map((plugin) => pluginNodeIndexKey(plugin.address))
		.sort((left, right) => left.localeCompare(right))
		.join('\n')
	const runningPluginKeys = useMemo(
		() => new Set(runningPluginSignature ? runningPluginSignature.split('\n') : []),
		[runningPluginSignature],
	)
	const transportClient = useRuntimeTransportClient()
	const localeSnapshot = useSyncExternalStore(
		(listener) => workbenchLocale.subscribe(listener),
		() => `${workbenchLocale.locale}::${workbenchLocale.fallbackLocale ?? ''}`,
		() => `${workbenchLocale.locale}::${workbenchLocale.fallbackLocale ?? ''}`,
	)

	const workbenchHost = useMemo<WorkbenchBrowserHost>(() => {
		// The locale service is mutable; its snapshot invalidates the host environment.
		void localeSnapshot
		return {
			runningPluginKeys,
			runningPluginsReady: pluginOverview.hasSnapshot,
			environment: {
				colorScheme,
				transport: transportClient,
				locale: workbenchLocale,
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
		}
	}, [colorScheme, localeSnapshot, pluginOverview.hasSnapshot, runningPluginKeys, transportClient])

	return (
		<WorkbenchRuntimeProvider active={workbenchActive} host={workbenchHost}>
			<NotificationCenterProvider>
				<ModalsProvider>
					<Notifications position="top-center" />
					<Outlet />
				</ModalsProvider>
			</NotificationCenterProvider>
		</WorkbenchRuntimeProvider>
	)
}
