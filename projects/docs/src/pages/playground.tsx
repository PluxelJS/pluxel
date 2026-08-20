import { ConfigurationPlaygroundPreview } from '../components/configuration-playground-preview'

export default function PlaygroundPage() {
	return (
		<>
			<title>配置 Playground | Pluxel</title>
			<meta name="description" content="在浏览器中编写 Valibot schema，实时预览生成的配置表单。" />
			<div className="configuration-playground-page">
				<ConfigurationPlaygroundPreview />
			</div>
		</>
	)
}
