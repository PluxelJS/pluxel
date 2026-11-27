import { m } from '#i18n'
import { useComputedColorScheme } from '@mantine/core'
import { pluginNodeIndexKey } from '@pluxel/core'
import { ModalsProvider, openConfirmModal } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { useMemo, type ReactNode } from 'react'
import { WorkbenchRuntimeProvider, type WorkbenchBrowserHost } from '../../workbench/runtime'
import { notifyAndRecord } from '../notifications/notifyBridge'
import { NotificationCenterProvider } from '../notifications/NotificationCenterProvider'
import { usePluginOverview } from '../plugins/pluginOverview'
import { AppLocaleProvider, useAppLocale } from './AppLocaleProvider'

export function AppProviders({ children }: { children: ReactNode }) {
	return (
		<AppLocaleProvider>
			<WorkbenchProviders>{children}</WorkbenchProviders>
		</AppLocaleProvider>
	)
}

function WorkbenchProviders({ children }: { children: ReactNode }) {
	const { locale } = useAppLocale()
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const pluginOverview = usePluginOverview()
	const runningPluginSignature = (pluginOverview.overview?.status.statuses ?? [])
		.filter((plugin) => plugin.lifecycleState === 'running')
		.map((plugin) => pluginNodeIndexKey(plugin.address))
		.sort((left, right) => left.localeCompare(right))
		.join('\n')
	const runningPluginKeys = useMemo(
		() => new Set(runningPluginSignature ? runningPluginSignature.split('\n') : []),
		[runningPluginSignature],
	)

	const workbenchHost = useMemo<WorkbenchBrowserHost>(() => {
		return {
			locale,
			colorScheme,
			runningPluginKeys,
			runningPluginsReady: pluginOverview.hasSnapshot,
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
							confirm: payload?.confirmLabel ?? m['actions.confirm']({}, { locale }),
							cancel: payload?.cancelLabel ?? m['actions.cancel']({}, { locale }),
						},
						confirmProps: payload?.tone === 'danger' ? { color: 'red' } : undefined,
						onConfirm: () => resolve(true),
						onCancel: () => resolve(false),
						onClose: () => resolve(false),
						closeOnConfirm: true,
					})
				})
			},
		}
	}, [colorScheme, locale, pluginOverview.hasSnapshot, runningPluginKeys])

	return (
		<WorkbenchRuntimeProvider host={workbenchHost}>
			<NotificationCenterProvider>
				<ModalsProvider>
					<Notifications position="top-center" />
					{children}
				</ModalsProvider>
			</NotificationCenterProvider>
		</WorkbenchRuntimeProvider>
	)
}
