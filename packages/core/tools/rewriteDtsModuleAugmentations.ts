import type { Plugin } from 'rolldown'

export function rewriteCoreDtsModuleAugmentations(): Plugin {
	const declarationFile = /\.d\.(?:mts|cts|ts)$/i
	const contextAugmentation = /(declare\s+module\s+)(['"])@pluxel\/context\2/g

	return {
		name: 'rewrite-core-dts-module-augmentations',
		generateBundle(_options, bundle) {
			for (const [file, output] of Object.entries(bundle)) {
				if (!declarationFile.test(file)) continue
				const code = output.type === 'asset' ? String(output.source) : String(output.code)
				const rewritten = code.replace(
					contextAugmentation,
					(_match, head, quote) => `${head}${quote}@pluxel/core${quote}`,
				)
				if (output.type === 'asset') output.source = rewritten
				else output.code = rewritten
			}
		},
	}
}
