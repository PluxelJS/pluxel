import { defineConfig } from 'wxt'

export default defineConfig({
	manifestVersion: 3,
	modules: ['@wxt-dev/auto-icons', '@wxt-dev/module-react'],
	autoIcons: { baseIconPath: 'assets/icon.svg' },
	manifest: {
		name: '净链 · Pluxel',
		permissions: ['activeTab', 'storage', 'contextMenus', 'scripting'],
	},
})
