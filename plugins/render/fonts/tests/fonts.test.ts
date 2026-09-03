import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { BasePlugin, Plugin, createRuntimeTestHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { FontsError, FontsPlugin, type FontRegistration } from '../src/index.ts'
import { FontsTestWorkbench, openFontsManager, openFontSelection } from './workbench-helpers.ts'

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

const fontPath = findTestFont()
const discoveredFamily = GlobalFonts.families[0]?.family

describe('FontsPlugin', () => {
	it('classifies fonts discovered from the host system and resolves an automatic default', async () => {
		{
			await using host = createRuntimeTestHost()

			await host.start([FontsPlugin, FontsLazyConsumer])
			const fonts = host.require(FontsLazyConsumer).fonts

			expect(fonts.families.every(({ source }) => source === 'system')).toBe(true)
			expect(fonts.defaultFont.cssFamily).toBeTruthy()
			expect(['system', 'generic']).toContain(fonts.defaultFont.source)
			expect(
				fonts.defaultFont.source !== 'system' ||
					fonts.families.some(({ family }) => family === fonts.defaultFont.family),
			).toBe(true)
			expect(host.isRunning(FontsPlugin)).toBe(true)
			await expect(openFontsManager(host)).rejects.toThrow(/workbench/i)
		}
	})

	it.skipIf(!discoveredFamily)(
		'persists a provider preference and resets to the host-configured family',
		async () => {
			const backend = createMemoryPersistenceBackend()
			{
				await using host = createRuntimeTestHost({
					persistence: { mode: 'custom', backend },
				})

				await host.start(FontsPlugin, {
					initialConfig: { defaultFamily: 'serif' },
				})
				await host.start(FontsTestConsumer)

				let fonts = host.require(FontsTestConsumer).fonts
				const selected = await fonts.setPreferredFamily(discoveredFamily!)
				expect(selected).toMatchObject({
					family: discoveredFamily,
					preferredFamily: discoveredFamily,
					configuredFamily: 'serif',
					source: 'preference',
				})

				await host.restart(FontsPlugin)
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
			await using host = createRuntimeTestHost()

			await host.start([FontsPlugin, FontsLazyConsumer])

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

			await host.stop(FontsLazyConsumer)
			expect(registration.active).toBe(false)
			expect(GlobalFonts.has(family)).toBe(false)
			registration.dispose()
		}
	})

	it.skipIf(!fontPath)('reference-counts duplicate portable resources by content ID', async () => {
		{
			await using host = createRuntimeTestHost()

			await host.start([FontsPlugin, FontsLazyConsumer])
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
			await using host = createRuntimeTestHost()

			await host.start(FontsPlugin, {
				initialConfig: { maxNativeRegistrations: 1 },
			})
			await host.start(FontsLazyConsumer)
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
				await using host = createRuntimeTestHost()

				await host.start(FontsPlugin, {
					initialConfig: { maxTotalFontBytes: byteLength },
				})
				await host.start(FontsLazyConsumer)
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
				await using host = createRuntimeTestHost({
					workbench: { enabled: true },
					persistence: { mode: 'custom', backend },
				})

				await host.start([FontsPlugin, FontsTestConsumer])

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

				await host.stop(FontsTestConsumer)
				expect(GlobalFonts.has(family)).toBe(true)

				await host.start(FontsTestConsumer)
				using restoredManager = await openFontsManager(host)
				const restored = await restoredManager.api.snapshot()
				expect(restored.managedFonts).toEqual([
					expect.objectContaining({ id, fileName: 'brand.ttf', family }),
				])
				expect(GlobalFonts.has(family)).toBe(true)

				await host.restart(FontsPlugin)
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
			await using host = createRuntimeTestHost()

			await host.start(FontsPlugin, { initialConfig: { maxFontBytes: 4 } })
			await host.start(FontsLazyConsumer)
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
			await using host = createRuntimeTestHost()

			await host.start([FontsPlugin, FontsLazyConsumer])
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
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await host.start(FontsPlugin, {
				initialConfig: {
					maxFontBytes: 2 * 1024 * 1024,
					maxPendingManagedTasks: 1,
				},
			})
			await host.start(FontsTestConsumer)
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
			await using host = createRuntimeTestHost()

			await host.start([FontsPlugin, FontsLazyConsumer])
			const registration = host.require(FontsLazyConsumer).fonts.register({
				data: new Uint8Array(2 * 1024 * 1024),
			})
			const result = registration.then(
				() => Object.freeze({ status: 'fulfilled' as const }),
				(error: unknown) => Object.freeze({ status: 'rejected' as const, error }),
			)

			await host.stop(FontsLazyConsumer)
			await expect(result).resolves.toMatchObject({
				status: 'rejected',
				error: { code: 'NOT_RUNNING' },
			})
		}
	})

	it.skipIf(!fontPath)('rejects oversized font files before reading their contents', async () => {
		{
			await using host = createRuntimeTestHost()

			await host.start(FontsPlugin, { initialConfig: { maxFontBytes: 4 } })
			await host.start(FontsLazyConsumer)
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
				await using host = createRuntimeTestHost({
					persistence: { mode: 'custom', backend },
				})

				const failure = await host.commitExpectFail((change) => {
					change.catalog.add([FontsPlugin, FontsLazyConsumer])
					change.start(FontsPlugin)
					change.start(FontsLazyConsumer)
				})
				expect(failure).toHavePluginLifecycleIssue(FontsPlugin, {
					kind: 'start-failed',
					message,
				})
				expect(host.isRunning(FontsPlugin)).toBe(false)
				expect(host.isRunning(FontsLazyConsumer)).toBe(false)
			}
		}
	})

	it('renders direct consumer and provider-owned Workbench views', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await host.start([FontsPlugin, FontsTestConsumer])

			using selection = await openFontSelection(host, FontsTestConsumer)
			using secondSelection = await openFontSelection(host, FontsTestConsumer)
			expect(secondSelection.provider).not.toBe(selection.provider)
			expect(selection).toMatchObject({
				kind: 'attachment',
				params: {},
				federatedViewRef: expect.any(Object),
			})
			await expect(selection.provider.setPreferredFamily(null)).resolves.toBeUndefined()
			await expect(selection.provider.snapshot()).resolves.toMatchObject({
				defaultFont: { family: expect.any(String) },
			})

			using manager = await openFontsManager(host)
			using secondManager = await openFontsManager(host)
			expect(secondManager.api).not.toBe(manager.api)
			expect(manager).toMatchObject({
				kind: 'view',
				params: {},
				federatedViewRef: expect.any(Object),
			})
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
