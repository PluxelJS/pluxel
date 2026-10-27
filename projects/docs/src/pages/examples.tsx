import { TypstExample } from '../examples/typst/example'

export default function ExamplesPage() {
	return (
		<>
			<title>Examples · Pluxel × Typst</title>
			<meta
				name="description"
				content="在纯浏览器中运行真实 Pluxel 插件，通过 Typst WASM 实时排版。"
			/>
			<TypstExample />
		</>
	)
}
