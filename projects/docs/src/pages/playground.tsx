import { ConfigurationPlaygroundPreview } from '../components/configuration-playground-preview'

export default function PlaygroundPage() {
	return (
		<>
			<title>配置 Playground | Pluxel</title>
			<meta
				name="description"
				content="在浏览器中编写 Valibot schema，查看类型提示、生成的表单以及 Input/Output。"
			/>
			<div className="configuration-playground-page">
				<ConfigurationPlaygroundPreview />
			</div>
		</>
	)
}
