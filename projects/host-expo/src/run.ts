import { createScriptScope } from '@pluxel/agent-sdk/host'
import {
	defineHostApplication,
	defineHostService,
	installScopeService,
} from '@pluxel/host/application'
import { startHost } from '@pluxel/host/embedded'
import {
	inspectHost,
	probeEnvironment,
	probePlugins,
} from '@pluxel-example/host-targets-plugins/probe'
import { getLocales } from 'expo-localization'
import { loadInstalledPlugin } from './installed-plugin'

const sourceUrl = 'https://expo.example.invalid/probe'
const expectedSource = 'Expo'
const runtime = crypto.randomUUID()

export async function run(signal: AbortSignal) {
	if (!('HermesInternal' in globalThis)) throw new Error('This example requires Hermes')
	const installed = await loadInstalledPlugin()
	const application = defineHostApplication(() => ({
		plugins: [
			...probePlugins(sourceUrl),
			...(installed ? [{ plugin: installed.plugin.DeviceLanguage, autoStart: true }] : []),
		],
		services: installed
			? [
					defineHostService({
						name: 'DeviceLocales',
						provides: [
							installScopeService(installed.plugin.DeviceLocales, {
								create: () => ({
									languageTags: () => getLocales().map((locale) => locale.languageTag),
								}),
							}),
						],
					}),
				]
			: [],
		coreConfig: {
			vault: { backend: 'bindings' },
			http: {
				allowedOrigins: [new URL(sourceUrl).origin],
				records: 'off',
				fetch: async (input) => {
					const request = new Request(input)
					if (request.url !== sourceUrl || request.method !== 'GET')
						throw new Error('Unexpected probe request')
					return new Response(JSON.stringify({ source: expectedSource }), {
						headers: { 'content-type': 'application/json' },
					})
				},
			},
		},
	}))
	await using host = await startHost(application, { env: probeEnvironment })
	await using scope = createScriptScope({ ctx: host.ctx, signal })
	const shared = await inspectHost(scope.sdk, { sourceUrl, expectedSource })
	const catalog = host.catalog().entries.map((entry) => entry.address.exportName)
	let languages: string[] | null = null
	if (installed) {
		const { instance } = await scope.sdk
			.plugin(installed.plugin.DeviceLanguage.nodeAddress())
			.instance()
		languages = instance.read()
	}
	return {
		engine: 'Hermes',
		runtime,
		catalog,
		pluginSha256: installed?.sha256 ?? null,
		languages,
		shared,
	}
}
