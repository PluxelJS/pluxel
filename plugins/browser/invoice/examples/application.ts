import { defineHostApplication, envBinding, type HostApplicationFactory } from '@pluxel/host'
import { PlaywrightConfig, PlaywrightPlugin } from '@pluxel/plugin-playwright'
import { InvoicePlugin, InvoiceVaultSchema } from '@pluxel/plugin-invoice'
import { InvoiceConsumer } from './consumer.ts'

const application: HostApplicationFactory = defineHostApplication((startup) => ({
	coreConfig: { vault: { backend: 'bindings' } },
	plugins: [
		{
			plugin: PlaywrightPlugin,
			envBindings: [
				envBinding({
					config: { schema: PlaywrightConfig, mapping: { endpoint: 'BROWSER_ENDPOINT' } },
				}),
			],
		},
		{
			plugin: InvoicePlugin,
			envBindings: [
				envBinding({
					vault: {
						schema: InvoiceVaultSchema,
						mapping: { primary: { apiKey: 'INVOICE_VLM_KEY' } },
					},
				}),
			],
			config: {
				vlm: {
					endpoint: startup.env.INVOICE_VLM_ENDPOINT,
					model: startup.env.INVOICE_VLM_MODEL,
					credentialKey: 'primary',
				},
				captchaAttempts: 1,
			},
		},
		{ plugin: InvoiceConsumer, autoStart: true },
	],
}))

export default application
