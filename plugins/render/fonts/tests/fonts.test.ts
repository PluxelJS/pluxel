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
	createRuntimeHost,
} from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { describe, expect, it } from 'vitest'
import { FontsError, FontsPlugin, type FontRegistration } from '../src/index.ts'
import { FontsWorkbench } from '../src/workbench.ts'
import { openFontsManager, openFontSelection } from './workbench-helpers.ts'

export const FontsTestWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(
		workbench.tab({ label: 'Fonts', icon: workbench.icons.Typography }),
	),
})

@Plugin()
class FontsTestConsumer extends BasePlugin {
	constructor(readonly fonts: FontsPlugin) {
		super()
	}

	override init(): void {
		this.ctx.workbench?.publish(FontsTestWorkbench, {
			fonts: { provider: this.fonts },
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
		{
			await using host = createRuntimeHost({ workbench: false })

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
		}
	})

	it.skipIf(!discoveredFamily)(
		'persists a provider preference and resets to the host-configured family',
		async () => {
			const backend = createMemoryPersistenceBackend()
			{
				await using host = createRuntimeHost({
					workbench: false,
					persistence: { mode: 'custom', backend },
				})

				addStarted(host, [FontsPlugin, FontsTestConsumer])
				host.cfg(FontsPlugin).set({ defaultFamily: 'serif' })
				await host.commit()

				let fonts = host.require(FontsTestConsumer).fonts
				const selected = await fonts.setPreferredFamily(discoveredFamily!)
				expect(selected).toMatchObject({
					family: discoveredFamily,
					preferredFamily: discoveredFamily,
					configuredFamily: 'serif',
					source: 'preference',
				})

				host.restart(FontsPlugin)
				await host.commit()
				fonts = host.require(FontsTestConsumer).fonts
				expect(fonts.defaultFont).toMatchObject({
					family: discoveredFamily,
					preferredFamily: discoveredFamily,
					source: 'preference',
				})

				const reset = await fonts.setPreferredFamily(null)
				expect(reset).toMatchObject({
					family: 'serif',
					configuredFamily: 'serif',
					source: 'config',
				})
				expect(reset.preferredFamily).toBeUndefined()
				await expect(fonts.setPreferredFamily('Definitely Missing Font')).rejects.toMatchObject({
					code: 'FONT_NOT_FOUND',
				})
			}
		},
	)

	it.skipIf(!fontPath)('owns native font registrations with the caller lifecycle', async () => {
		const family = `Pluxel Lifecycle ${crypto.randomUUID()}`
		let registration: FontRegistration | undefined
		{
			await using host = createRuntimeHost({ workbench: false })

			addStarted(host, [FontsPlugin, FontsLazyConsumer])
			await host.commit()

			registration = await host.require(FontsLazyConsumer).fonts.registerFromPath({
				path: fontPath!,
				family,
			})
			const fonts = host.require(FontsLazyConsumer).fonts
			expect(fonts.portableFonts.fonts[0]?.resolvedFamilies).toContain(family)
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
		}
	})

	it.skipIf(!fontPath)('reference-counts duplicate portable resources by content ID', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

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
		}
	})

	it.skipIf(!fontPath)('bounds native registrations across managed and caller fonts', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

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
		}
	})

	it.skipIf(!fontPath)(
		'bounds aggregate native font bytes and returns capacity on dispose',
		async () => {
			const fontData = await readFile(fontPath!)
			const byteLength = fontData.byteLength
			{
				await using host = createRuntimeHost({ workbench: false })

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
			}
		},
	)

	it.skipIf(!fontPath)(
		'keeps one provider-owned managed collection across consumer lifecycles and reloads',
		async () => {
			const backend = createMemoryPersistenceBackend()
			const family = `Pluxel Managed ${crypto.randomUUID()}`
			const data = await readFile(fontPath!)

			{
				await using host = createRuntimeHost({
					workbench: { enabled: true },
					persistence: { mode: 'custom', backend },
				})

				addStarted(host, [FontsPlugin, FontsTestConsumer])
				await host.commit()

				using manager = await openFontsManager(host)
				const installed = await Promise.all([
					manager.api.install({ fileName: 'brand.ttf', family, data }),
					manager.api.install({ fileName: 'brand-copy.ttf', family, data }),
				])
				expect(installed).toEqual([undefined, undefined])
				const first = await manager.api.snapshot()
				expect(first.managedFonts).toHaveLength(1)
				expect(GlobalFonts.has(family)).toBe(true)
				const id = first.managedFonts[0]!.id

				host.stop(FontsTestConsumer)
				await host.commit()
				expect(GlobalFonts.has(family)).toBe(true)

				host.start(FontsTestConsumer)
				await host.commit()
				using restoredManager = await openFontsManager(host)
				const restored = await restoredManager.api.snapshot()
				expect(restored.managedFonts).toEqual([
					expect.objectContaining({ id, fileName: 'brand.ttf', family }),
				])
				expect(GlobalFonts.has(family)).toBe(true)

				host.restart(FontsPlugin)
				await host.commit()
				using reloadedManager = await openFontsManager(host)
				const reloaded = await reloadedManager.api.snapshot()
				expect(reloaded.managedFonts).toEqual([
					expect.objectContaining({ id, fileName: 'brand.ttf', family }),
				])
				expect(GlobalFonts.has(family)).toBe(true)

				await expect(reloadedManager.api.remove(id)).resolves.toBeUndefined()
				const removed = await reloadedManager.api.snapshot()
				expect(removed.managedFonts).toEqual([])
				expect(GlobalFonts.has(family)).toBe(false)
			}
		},
	)

	it('rejects invalid bytes and enforces the configured byte budget', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

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
		}
	})

	it('cooperatively snapshots registration bytes and observes cancellation', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

			addStarted(host, [FontsPlugin, FontsLazyConsumer])
			await host.commit()
			const controller = new AbortController()
			const registration = host.require(FontsLazyConsumer).fonts.register({
				data: new Uint8Array(2 * 1024 * 1024),
				signal: controller.signal,
			})
			queueMicrotask(() => controller.abort())
			await expect(registration).rejects.toMatchObject({ name: 'AbortError' })
		}
	})

	it('bounds the serialized managed-font queue before snapshotting upload bytes', async () => {
		{
			await using host = createRuntimeHost({ workbench: { enabled: true } })

			addStarted(host, [FontsPlugin, FontsTestConsumer])
			host.cfg(FontsPlugin).set({
				maxFontBytes: 2 * 1024 * 1024,
				maxPendingManagedTasks: 1,
			})
			await host.commit()
			using manager = await openFontsManager(host)
			const active = manager.api.install({
				fileName: 'invalid.ttf',
				data: new Uint8Array(2 * 1024 * 1024),
			})

			await expect(manager.api.snapshot()).rejects.toMatchObject({ code: 'FONT_BUSY' })
			await expect(active).rejects.toMatchObject({ code: 'INVALID_FONT' })
		}
	})

	it('does not commit an async registration after its caller generation stops', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

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
		}
	})

	it.skipIf(!fontPath)('rejects oversized font files before reading their contents', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

			addStarted(host, [FontsPlugin, FontsLazyConsumer])
			host.cfg(FontsPlugin).set({ maxFontBytes: 4 })
			await host.commit()
			const fonts = host.require(FontsLazyConsumer).fonts

			await expect(fonts.registerFromPath({ path: fontPath! })).rejects.toMatchObject({
				code: 'FONT_TOO_LARGE',
			} satisfies Partial<FontsError>)
		}
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
			{
				await using host = createRuntimeHost({
					workbench: false,
					persistence: { mode: 'custom', backend },
				})

				addStarted(host, [FontsPlugin, FontsLazyConsumer])
				const summary = await host.commitAllowFail()
				assertPluginLifecycleIssue(summary, FontsPlugin, { kind: 'start-failed', message })
				expect(host.isRunning(FontsPlugin)).toBe(false)
				expect(host.isRunning(FontsLazyConsumer)).toBe(false)
			}
		}
	})

	it('renders direct consumer and provider-owned Workbench views', async () => {
		{
			await using host = createRuntimeHost({ workbench: { enabled: true } })

			addStarted(host, [FontsPlugin, FontsTestConsumer])
			await host.commit()

			const registry = requireWorkbench(host.ctx).registry
			const consumer = pluginNodeAddressOf(FontsTestConsumer)
			const provider = pluginNodeAddressOf(FontsPlugin)
			const layout = registry.getLayout(consumer)
			expect(layout.entries).toEqual([
				expect.objectContaining({
					descriptor: {
						kind: 'attachment-placement',
						consumer: consumer.definition,
						key: 'fonts',
						provider: {
							kind: 'attachment',
							owner: provider.definition,
							key: 'selection',
						},
					},
					target: {
						node: consumer,
						displayName: 'FontsTestConsumer',
					},
					renderer: provider,
					placement: { kind: 'tab', label: 'Fonts', icon: 'typography', order: 0 },
				}),
			])
			using selection = await openFontSelection(host, FontsTestConsumer)
			using secondSelection = await openFontSelection(host, FontsTestConsumer)
			expect(secondSelection.api).not.toBe(selection.api)
			await expect(selection.api.setPreferredFamily(null)).resolves.toBeUndefined()
			await expect(selection.api.snapshot()).resolves.toMatchObject({
				defaultFont: { family: expect.any(String) },
			})

			const providerLayout = registry.getLayout(provider)
			expect(providerLayout.entries).toEqual([
				expect.objectContaining({
					descriptor: { kind: 'view', owner: provider.definition, key: 'manager' },
					target: {
						node: provider,
						displayName: 'FontsPlugin',
					},
					renderer: provider,
					placement: { kind: 'tab', label: 'Fonts', icon: 'typography', order: 0 },
				}),
			])
			using manager = await openFontsManager(host)
			using secondManager = await openFontsManager(host)
			expect(secondManager.api).not.toBe(manager.api)
			await expect(manager.api.setPreferredFamily(null)).resolves.toBeUndefined()
			await expect(manager.api.snapshot()).resolves.toMatchObject({ managedFonts: [] })
		}
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
