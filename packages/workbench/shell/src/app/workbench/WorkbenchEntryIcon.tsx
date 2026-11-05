import {
	IconApi,
	IconApps,
	IconBrandDiscord,
	IconBrandTelegram,
	IconBuilding,
	IconChartBar,
	IconCloudUpload,
	IconHistory,
	IconMessageChatbot,
	IconPlugConnected,
	IconReceipt,
	IconSearch,
	IconSettings,
	IconShieldLock,
	IconTestPipe,
	IconTextRecognition,
	IconTypography,
	IconUsers,
} from '@tabler/icons-react'
import type { WorkbenchIcon } from '@pluxel/workbench'

const icons = {
	api: IconApi,
	'brand-discord': IconBrandDiscord,
	'brand-telegram': IconBrandTelegram,
	building: IconBuilding,
	'chart-bar': IconChartBar,
	'cloud-upload': IconCloudUpload,
	history: IconHistory,
	'message-chatbot': IconMessageChatbot,
	'plug-connected': IconPlugConnected,
	receipt: IconReceipt,
	search: IconSearch,
	settings: IconSettings,
	'shield-lock': IconShieldLock,
	'test-pipe': IconTestPipe,
	'text-recognition': IconTextRecognition,
	typography: IconTypography,
	users: IconUsers,
} satisfies Record<WorkbenchIcon, typeof IconApps>

export function WorkbenchEntryIcon({ icon }: { icon?: WorkbenchIcon }) {
	const Icon = icon ? icons[icon] : IconApps
	return <Icon size={20} stroke={1.7} aria-hidden />
}
