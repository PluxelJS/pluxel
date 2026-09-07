import { FontsPlugin } from '@pluxel/fonts'
import type { PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	createRuntimeTestHost,
	Plugin,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { TakumiPlugin } from '@pluxel/takumi'
import { TakumiMarkdownPlugin } from '@pluxel/takumi-markdown'
import { describe, expect, it } from 'vitest'
import { TypstMathPlugin } from '../src/index.ts'

@Plugin()
class TypstMathTestConsumer extends BasePlugin {
	constructor(
		readonly markdown: TakumiMarkdownPlugin,
		readonly typst: TypstMathPlugin,
	) {
		super()
	}
}

async function startTypstFixture(host: RuntimeTestHost): Promise<void> {
	const plugins: readonly PluginConstructor[] = [
		FontsPlugin,
		TakumiPlugin,
		TakumiMarkdownPlugin,
		TypstMathPlugin,
		TypstMathTestConsumer,
	]
	await host.commit((change) => {
		change.catalog.add(plugins)
		change.start(plugins)
	})
}

describe('TypstMathPlugin', () => {
	it('preserves rejected unsafe math as a TypstMathError through the Markdown renderer', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startTypstFixture(host)
		const consumer = host.require(TypstMathTestConsumer)
		const renderer = consumer.markdown.createRenderer({
			extensions: [consumer.typst.createMarkdownExtension()],
		})
		try {
			await expect(
				renderer.render({ markdown: '$#let unsafe = 1$', width: 64, height: 32 }),
			).rejects.toMatchObject({ name: 'TypstMathError', code: 'FORMULA_INVALID' })
		} finally {
			await renderer.close()
		}
	})
})
