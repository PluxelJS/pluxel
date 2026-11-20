import { expect, it } from 'vitest'
import { BasePlugin, parsePluginNodeAddress, Plugin, PluginPart } from '@pluxel/core'
import { createCoreTestHost } from '@pluxel/core/internal/test'

type Phase = 'construction' | 'init' | 'close'
let failDuring: Phase | undefined
const events: string[] = []

class IndexPart extends PluginPart<WorkspacePart> {
	constructor() {
		super()
		events.push('allocate index')
		this.ctx.effects.defer(() => {
			events.push('release index')
			if (failDuring === 'close') throw new Error('index close failed')
		})
		if (failDuring === 'construction') throw new Error('index construction failed')
	}

	protected override init() {
		events.push('load index')
		if (failDuring === 'init') throw new Error('index init failed')
	}
}

class WorkspacePart extends PluginPart<Search> {
	private readonly index = this.parts.use(IndexPart)

	protected override init() {
		events.push('attach workspace')
		return () => {
			events.push('detach workspace')
		}
	}
}

@Plugin()
export class Search extends BasePlugin {
	private readonly workspace = this.parts.use(WorkspacePart)

	protected override init() {
		events.push('publish search')
		return () => {
			events.push('withdraw search')
		}
	}
}

it('starts nested Parts before their owner and releases them after the owner stops', async () => {
	failDuring = undefined
	events.length = 0
	await using host = createCoreTestHost()
	await host.add(Search.nodeAddress())
	await host.remove(Search.nodeAddress())
	expect(events).toEqual([
		'allocate index',
		'load index',
		'attach workspace',
		'publish search',
		'withdraw search',
		'detach workspace',
		'release index',
	])
})

it.each([
	{ phase: 'construction', kind: 'resolve-failed' },
	{ phase: 'init', kind: 'start-failed' },
	{ phase: 'close', kind: 'drain-failed' },
] as const)(
	'reports an index $phase failure on the owning Plugin and releases the index',
	async ({ phase, kind }) => {
		failDuring = phase
		events.length = 0
		await using host = createCoreTestHost()
		const node = Search.nodeAddress()
		if (phase === 'close') await host.add(node)
		const result = await host.commitExpectFail((change) =>
			phase === 'close' ? change.remove(node) : change.add(node),
		)
		expect(result.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				plugin: parsePluginNodeAddress(node),
				kind,
				message: expect.stringContaining(`index ${phase} failed`),
				error: expect.objectContaining({ partPath: ['workspace', 'index'] }),
			}),
		)
		expect(host.isRunning(node)).toBe(false)
		expect(events.at(0)).toBe('allocate index')
		expect(events.at(-1)).toBe('release index')
		expect(events.includes('publish search')).toBe(phase === 'close')
	},
)

class CrossIndex extends PluginPart<Importer> {
	constructor(readonly source: Source) {
		super()
	}
}

@Plugin()
export class Importer extends BasePlugin {
	private readonly index = this.parts.use(CrossIndex)
}

@Plugin()
export class Source extends BasePlugin {
	constructor(readonly importer: Importer) {
		super()
	}
}

it('identifies the Part constructor responsible for a dependency cycle', async () => {
	await using host = createCoreTestHost()
	await expect(host.add([Importer.nodeAddress(), Source.nodeAddress()])).rejects.toThrow(
		/Part index constructor \(required\)/,
	)
	expect(host.isRunning(Importer.nodeAddress())).toBe(false)
})
