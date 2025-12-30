/**
 * Shared vendor package list for plugin UI extension bundles.
 *
 * These packages are expected to be provided by the host app via `window.__PLUXEL_VENDORS__`,
 * so extension bundles can externalize them and avoid shipping duplicate copies.
 */
export const extensionVendorPackages = [
	// React
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',

	// Mantine
	'@mantine/core',
	'@mantine/hooks',
	'@mantine/modals',
	'@mantine/notifications',

	// Host-provided browser client helpers
	'capnweb',
	'@pluxel/hmr-web',
	'@pluxel/hmr/web',
	'@pluxel/hmr/capnweb',
	'@pluxel/hmr-web/react',
	'@pluxel/hmr/web/react',
] as const

export type ExtensionVendorPackage = (typeof extensionVendorPackages)[number]
