import { createHomeLayout } from 'fumapress/layouts/home'
import { ConfigurationPlaygroundPreview } from '../components/configuration-playground-preview'

const HomeLayout = createHomeLayout()

export default function PlaygroundPage() {
	return (
		<>
			<title>配置 Playground | Pluxel</title>
			<meta
				name="description"
				content="在浏览器中编写 Valibot schema，查看类型提示、生成的表单以及 Input/Output。"
			/>
			<HomeLayout>
				<div className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col px-3 py-4 sm:px-6 sm:py-6">
					<ConfigurationPlaygroundPreview />
				</div>
			</HomeLayout>
		</>
	)
}
