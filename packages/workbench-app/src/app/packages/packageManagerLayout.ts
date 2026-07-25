import { sanitizeTwoPanelLayout } from '../workbench/split'

export const PACKAGE_INSTALL_PANEL_ID = 'pluxel-packages-install'
export const PACKAGE_LIST_PANEL_ID = 'pluxel-packages-list'
export const PACKAGE_SPLIT_LAYOUT_STORAGE_KEY = 'pluxel:packages:split'

export const DEFAULT_PACKAGE_SPLIT_LAYOUT = {
	[PACKAGE_INSTALL_PANEL_ID]: 24,
	[PACKAGE_LIST_PANEL_ID]: 76,
}

export function sanitizePackageSplitLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_PACKAGE_SPLIT_LAYOUT,
		PACKAGE_INSTALL_PANEL_ID,
		18,
		52,
	)
}
