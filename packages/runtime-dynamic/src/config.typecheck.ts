import { defineDynamicRuntimeConfig } from './config.ts'

defineDynamicRuntimeConfig({
	root: '/repo',
	storage: { persistenceDir: '.pluxel/persistence' },
	management: true,
	workbench: { enabled: true, uiBasePath: '/admin' },
})

// @ts-expect-error Dynamic config rejects the removed Workbench access option.
defineDynamicRuntimeConfig({
	root: '/repo',
	workbench: { enabled: true, access: { exposure: 'private' } },
})

// @ts-expect-error Dynamic config rejects the removed Workbench pluginGroups option.
defineDynamicRuntimeConfig({ root: '/repo', workbench: { enabled: true, pluginGroups: [] } })

// @ts-expect-error Dynamic config rejects unknown nested storage options.
defineDynamicRuntimeConfig({ root: '/repo', storage: { persistenceDir: '.pluxel', extra: true } })

// @ts-expect-error Dynamic config rejects unknown top-level options.
defineDynamicRuntimeConfig({ root: '/repo', unknownHostOption: true })
