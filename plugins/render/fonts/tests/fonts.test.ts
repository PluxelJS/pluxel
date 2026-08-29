import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'
import { createMemoryPersistenceBackend, type PluginConstructor } from '@pluxel/runtime'
import {
	assertPluginLifecycleIssue,
	BasePlugin,
	Plugin,
	pluginNodeAddressOf,
	type RuntimeHost,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { describe, expect, it } from 'vitest'
import { FontsError, FontsPlugin, type FontRegistration } from '../src/index.ts'
import type { FontsWorkbenchCommands } from '../src/manager-contract.ts'
import { FontsSelectionPort } from '../src/workbench-contract.ts'

const ConsumerWorkbench = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({
		label: 'Fonts',
		icon: workbenchContract.icons.Typography,
	}),
})

@Plugin()
class FontsTestConsumer extends BasePlugin {
	constructor(readonly fonts: FontsPlugin) {
		super()
	}

	override init(): void {
		this.ctx.workbench?.mount(ConsumerWorkbench, {
			selection: workbench.bind.rpc(() => this.fonts.selectionManager()),
		})
	}
}

@Plugin()
class FontsLazyConsumer extends BasePlugin {
	constructor(readonly fonts: FontsPlugin) {
		super()
	}
}

function addStarted(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.start(PluginClass)
}

const fontPath = findTestFont()
const discoveredFamily = GlobalFonts.families[0]?.family

describe('FontsPlugin', () => {
	it('classifies fonts discovered from the host system and resolves an automatic default', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts

				expect(fonts.families.every(({ source }) => source === 'system')).toBe(true)
				expect(fonts.defaultFont.cssFamily).toBeTruthy()
				expect(['system', 'generic']).toContain(fonts.defaultFont.source)
				expect(
					fonts.defaultFont.source !== 'system' ||
						fonts.families.some(({ family }) => family === fonts.defaultFont.family),
				).toBe(true)
				expect(host.isRunning(FontsPlugin)).toBe(true)
				expect('workbench' in host.ctx).toBe(false)
				expect(host.ctx.workbench).toBeUndefined()
			},
			{ workbench: false },
		)
	})

	it.skipIf(!discoveredFamily)(
		'persists a Workbench default and resets to the host-configured family',
		async () => {
			const backend = createMemoryPersistenceBackend()
			await withRuntimeHost(
				async (host) => {
					addStarted(host, [FontsPlugin, FontsTestConsumer])
					host.cfg(FontsPlugin).set({ defaultFamily: 'serif' })
					await host.commit()

					let commands = host.require(FontsTestConsumer).fonts.selectionManager()
					const selected = await commands.setDefaultFamily(discoveredFamily!)
					expect(selected.defaultFont).toMatchObject({
						family: discoveredFamily,
						workbenchFamily: discoveredFamily,
						configuredFamily: 'serif',
						source: 'workbench',
					})

					host.restart(FontsPlugin)
					await host.commit()
					commands = host.require(FontsTestConsumer).fonts.selectionManager()
					const restored = await commands.snapshot()
					expect(restored.defaultFont).toMatchObject({
						family: discoveredFamily,
						workbenchFamily: discoveredFamily,
						source: 'workbench',
					})

					const reset = await commands.setDefaultFamily(null)
					expect(reset.defaultFont).toMatchObject({
						family: 'serif',
						configuredFamily: 'serif',
						source: 'config',
					})
					expect(reset.defaultFont.workbenchFamily).toBeUndefined()
					await expect(commands.setDefaultFamily('Definitely Missing Font')).rejects.toMatchObject({
						code: 'FONT_NOT_FOUND',
					})
				},
				{ workbench: false, persistence: { mode: 'custom', backend } },
			)
		},
	)

	it.skipIf(!fontPath)('owns native font registrations with the caller lifecycle', async () => {
		const family = `Pluxel Lifecycle ${crypto.randomUUID()}`
		let registration: FontRegistration | undefined
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				await host.commit()

				registration = await host.require(FontsLazyConsumer).fonts.registerFromPath({
					path: fontPath!,
					family,
				})
				const portableSelection = await host
					.require(FontsLazyConsumer)
					.fonts.selectionManager('portable')
					.snapshot()
				expect(portableSelection.families.map((font) => font.family)).toEqual([family])
				expect(registration.active).toBe(true)
				expect(registration.families).toContain(family)
				expect(GlobalFonts.has(family)).toBe(true)
				expect(
					host.require(FontsLazyConsumer).fonts.families.find((item) => item.family === family),
				).toMatchObject({ source: 'registered' })

				host.stop(FontsLazyConsumer)
				await host.commit()
				expect(registration.active).toBe(false)
				expect(GlobalFonts.has(family)).toBe(false)
				registration.dispose()
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)('reference-counts duplicate portable resources by content ID', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts
				const family = `Pluxel Portable ${crypto.randomUUID()}`
				const first = await fonts.registerFromPath({ path: fontPath!, family })
				const second = await fonts.registerFromPath({ path: fontPath!, family })

				const attached = fonts.portableFonts
				expect(attached.fonts).toHaveLength(1)
				first.dispose()
				expect(fonts.portableFonts).toBe(attached)
				second.dispose()
				expect(fonts.portableFonts.fonts).toEqual([])
				expect(fonts.portableFonts.revision).toBeGreaterThan(attached.revision)
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)('bounds native registrations across managed and caller fonts', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				host.cfg(FontsPlugin).set({ maxNativeRegistrations: 1 })
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts
				const first = await fonts.registerFromPath({
					path: fontPath!,
					family: `Pluxel Native Limit ${crypto.randomUUID()}`,
				})

				await expect(
					fonts.registerFromPath({
						path: fontPath!,
						family: `Pluxel Native Overflow ${crypto.randomUUID()}`,
					}),
				).rejects.toMatchObject({ code: 'FONT_LIMIT_EXCEEDED' })
				first.dispose()
				const replacement = await fonts.registerFromPath({
					path: fontPath!,
					family: `Pluxel Native Replacement ${crypto.randomUUID()}`,
				})
				replacement.dispose()
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)(
		'bounds aggregate native font bytes and returns capacity on dispose',
		async () => {
			const fontData = await readFile(fontPath!)
			const byteLength = fontData.byteLength
			await withRuntimeHost(
				async (host) => {
					addStarted(host, [FontsPlugin, FontsLazyConsumer])
					host.cfg(FontsPlugin).set({ maxTotalFontBytes: byteLength })
					await host.commit()
					const fonts = host.require(FontsLazyConsumer).fonts
					const first = await fonts.registerFromPath({
						path: fontPath!,
						family: `Pluxel Byte Limit ${crypto.randomUUID()}`,
					})

					await expect(
						fonts.registerFromPath({
							path: fontPath!,
							family: `Pluxel Byte Overflow ${crypto.randomUUID()}`,
						}),
					).rejects.toMatchObject({ code: 'FONT_LIMIT_EXCEEDED' })
					first.dispose()
					const replacement = await fonts.registerFromPath({
						path: fontPath!,
						family: `Pluxel Byte Replacement ${crypto.randomUUID()}`,
					})
					replacement.dispose()
				},
				{ workbench: false },
			)
		},
	)

	it.skipIf(!fontPath)(
		'keeps one provider-owned managed collection across consumer lifecycles and reloads',
		async () => {
			const backend = createMemoryPersistenceBackend()
			const family = `Pluxel Managed ${crypto.randomUUID()}`
			const data = await readFile(fontPath!)

			await withRuntimeHost(
				async (host) => {
					addStarted(host, [FontsPlugin, FontsTestConsumer])
					await host.commit()

					const commands = managerForTest(host.require(FontsPlugin))
					const [first, duplicate] = await Promise.all([
						commands.install({ fileName: 'brand.ttf', family, data }),
						commands.install({ fileName: 'brand-copy.ttf', family, data }),
					])
					expect(first.managedFonts).toHaveLength(1)
					expect(duplicate.managedFonts).toHaveLength(1)
					expect(GlobalFonts.has(family)).toBe(true)
					const id = first.managedFonts[0]!.id

					host.stop(FontsTestConsumer)
					await host.commit()
					expect(GlobalFonts.has(family)).toBe(true)

					host.start(FontsTestConsumer)
					await host.commit()
					const restored = await managerForTest(host.require(FontsPlugin)).snapshot()
					expect(restored.managedFonts).toEqual([
						expect.objectContaining({ id, fileName: 'brand.ttf', family }),
					])
					expect(GlobalFonts.has(family)).toBe(true)

					host.restart(FontsPlugin)
					await host.commit()
					const reloaded = await managerForTest(host.require(FontsPlugin)).snapshot()
					expect(reloaded.managedFonts).toEqual([
						expect.objectContaining({ id, fileName: 'brand.ttf', family }),
					])
					expect(GlobalFonts.has(family)).toBe(true)

					const removed = await managerForTest(host.require(FontsPlugin)).remove(id)
					expect(removed.managedFonts).toEqual([])
					expect(GlobalFonts.has(family)).toBe(false)
				},
				{ workbench: false, persistence: { mode: 'custom', backend } },
			)
		},
	)

	it('rejects invalid bytes and enforces the configured byte budget', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				host.cfg(FontsPlugin).set({ maxFontBytes: 4 })
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts

				await expect(fonts.register({ data: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({
					code: 'INVALID_FONT',
				} satisfies Partial<FontsError>)
				await expect(fonts.register({ data: new Uint8Array(5) })).rejects.toMatchObject({
					code: 'FONT_TOO_LARGE',
				} satisfies Partial<FontsError>)
			},
			{ workbench: false },
		)
	})

	it('cooperatively snapshots registration bytes and observes cancellation', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				await host.commit()
				const controller = new AbortController()
				const registration = host.require(FontsLazyConsumer).fonts.register({
					data: new Uint8Array(2 * 1024 * 1024),
					signal: controller.signal,
				})
				queueMicrotask(() => controller.abort())
				await expect(registration).rejects.toMatchObject({ name: 'AbortError' })
			},
			{ workbench: false },
		)
	})

	it('bounds the serialized managed Workbench queue before snapshotting upload bytes', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsTestConsumer])
				host.cfg(FontsPlugin).set({
					maxFontBytes: 2 * 1024 * 1024,
					maxPendingManagedTasks: 1,
				})
				await host.commit()
				const commands = managerForTest(host.require(FontsPlugin))
				const active = commands.install({
					fileName: 'invalid.ttf',
					data: new Uint8Array(2 * 1024 * 1024),
				})

				await expect(commands.snapshot()).rejects.toMatchObject({ code: 'FONT_BUSY' })
				await expect(active).rejects.toMatchObject({ code: 'INVALID_FONT' })
			},
			{ workbench: false },
		)
	})

	it('does not commit an async registration after its caller generation stops', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				await host.commit()
				const registration = host.require(FontsLazyConsumer).fonts.register({
					data: new Uint8Array(2 * 1024 * 1024),
				})
				const result = registration.then(
					() => Object.freeze({ status: 'fulfilled' as const }),
					(error: unknown) => Object.freeze({ status: 'rejected' as const, error }),
				)

				host.stop(FontsLazyConsumer)
				await host.commit()
				await expect(result).resolves.toMatchObject({
					status: 'rejected',
					error: { code: 'NOT_RUNNING' },
				})
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)('rejects oversized font files before reading their contents', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				host.cfg(FontsPlugin).set({ maxFontBytes: 4 })
				await host.commit()
				const fonts = host.require(FontsLazyConsumer).fonts

				await expect(fonts.registerFromPath({ path: fontPath! })).rejects.toMatchObject({
					code: 'FONT_TOO_LARGE',
				} satisfies Partial<FontsError>)
			},
			{ workbench: false },
		)
	})

	it('fails the provider instead of silently skipping corrupt persisted state', async () => {
		const fontBackend = createMemoryPersistenceBackend()
		await fontBackend
			.namespace('@pluxel/fonts')
			.put(`managed/${'a'.repeat(43)}.font`, new Uint8Array([1, 2, 3]))
		const selectionBackend = createMemoryPersistenceBackend()
		await selectionBackend.namespace('@pluxel/fonts').put('settings/default-font.json', '{broken')

		for (const [backend, message] of [
			[fontBackend, 'Managed font is corrupt'],
			[selectionBackend, 'Default font preference is corrupt'],
		] as const) {
			await withRuntimeHost(
				async (host) => {
					addStarted(host, [FontsPlugin, FontsLazyConsumer])
					const summary = await host.commitAllowFail()
					assertPluginLifecycleIssue(summary, FontsPlugin, { kind: 'start-failed', message })
					expect(host.isRunning(FontsPlugin)).toBe(false)
					expect(host.isRunning(FontsLazyConsumer)).toBe(false)
				},
				{ workbench: false, persistence: { mode: 'custom', backend } },
			)
		}
	})

	it('renders direct consumer and provider-owned Workbench views', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [FontsPlugin, FontsTestConsumer])
				await host.commit()

				const registry = requireWorkbench(host.ctx).registry
				const layout = registry.getPluginLayout(pluginNodeAddressOf(FontsTestConsumer))
				expect(layout.items).toEqual([
					expect.objectContaining({
						owner: {
							address: pluginNodeAddressOf(FontsPlugin),
							displayName: 'FontsPlugin',
							rootExportName: 'FontsPlugin',
						},
						target: {
							address: pluginNodeAddressOf(FontsTestConsumer),
							displayName: 'FontsTestConsumer',
							rootExportName: 'FontsTestConsumer',
						},
						viewId: 'FontSelection',
						port: expect.objectContaining({
							id: '@pluxel/fonts.selection',
							model: { selection: expect.objectContaining({ kind: 'rpc' }) },
						}),
					}),
				])

				const providerLayout = registry.getPluginLayout(pluginNodeAddressOf(FontsPlugin))
				expect(providerLayout.items).toEqual([
					expect.objectContaining({
						owner: {
							address: pluginNodeAddressOf(FontsPlugin),
							displayName: 'FontsPlugin',
							rootExportName: 'FontsPlugin',
						},
						target: {
							address: pluginNodeAddressOf(FontsPlugin),
							displayName: 'FontsPlugin',
							rootExportName: 'FontsPlugin',
						},
						viewId: 'Fonts',
						model: { fonts: expect.objectContaining({ kind: 'rpc' }) },
					}),
				])
			},
			{ workbench: { enabled: true } },
		)
	})
})

function findTestFont(): string | undefined {
	const candidates = [
		'/usr/share/fonts/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
		'/System/Library/Fonts/Supplemental/Arial.ttf',
		process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'arial.ttf') : '',
	]
	return candidates.find((candidate) => candidate && existsSync(candidate))
}

function managerForTest(fonts: FontsPlugin): FontsWorkbenchCommands {
	return (
		fonts as unknown as {
			createWorkbenchManager(): FontsWorkbenchCommands
		}
	).createWorkbenchManager()
}
