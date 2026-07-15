import type { OutputChunk, Plugin } from 'rolldown'
import type { InlineConfig } from 'tsdown'
import Macros from 'unplugin-macros/rolldown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils'

type TsdownInputOptions = NonNullable<InlineConfig['inputOptions']>
type TsdownTransformOptions = NonNullable<TsdownInputOptions['transform']>

export function createPluginSourcePlugins(root: string): NonNullable<InlineConfig['plugins']> {
	return [
		PreprocessorDirectives(),
		Macros({
			viteConfig: {
				configFile: false,
				root,
			},
		}),
		decoratorOutputGuardPlugin(),
	]
}

export function createPluginTransformOptions(): TsdownTransformOptions {
	return {
		assumptions: {
			setPublicClassFields: true,
		},
		decorator: {
			legacy: true,
			emitDecoratorMetadata: true,
		},
		typescript: {
			removeClassFieldsWithoutInitializer: true,
		},
	}
}

function decoratorOutputGuardPlugin(): Plugin {
	return {
		name: 'pluxel:decorator-output-guard',
		generateBundle(_, bundle) {
			for (const item of Object.values(bundle)) {
				if (item.type !== 'chunk') continue
				assertNoUnloweredDecorators(this, item)
			}
		},
	}
}

function assertNoUnloweredDecorators(
	context: { error(message: string): never },
	chunk: OutputChunk,
): void {
	const ast = parseStandaloneWithLang(chunk.code, chunk.fileName)
	if (!ast) context.error(`[pluxel:build] failed to validate generated chunk ${chunk.fileName}`)
	if (hasUnloweredDecorators(ast)) {
		context.error(
			`[pluxel:build] generated chunk ${chunk.fileName} still contains decorator syntax; Pluxel plugin sources must use the shared legacy decorator transform`,
		)
	}
}

function hasUnloweredDecorators(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(hasUnloweredDecorators)
	const node = value as Record<string, unknown>
	if (Array.isArray(node.decorators) && node.decorators.length > 0) return true
	return Object.values(node).some(hasUnloweredDecorators)
}
