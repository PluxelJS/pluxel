import { MantineProvider, Tabs, Stack } from '@mantine/core'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OutlineNavigator } from '../src/app/plugins/detail/workbench/OutlineNavigator'
import '@mantine/core/styles.css'
import '../src/app/workbench/styles/_plugin-layout.scss'
import '../src/app/workbench/styles/_plugin-panels.scss'
function App() {
	const [active, setActive] = useState('heading-0')
	return (
		<MantineProvider>
			<div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>
				<div id="editor" style={{ flex: 1, overflow: 'auto' }}>
					<div style={{ height: 3000 }}>Editor</div>
				</div>
				<Tabs
					defaultValue="inspect"
					keepMounted
					className="plx-paneTabs plx-pluginWorkbench__contextRail"
					style={{ width: 320, flex: '0 0 320px' }}
				>
					<div className="plx-pluginWorkbench__viewHeader">
						<Tabs.List>
							<Tabs.Tab value="inspect">概览</Tabs.Tab>
							<Tabs.Tab value="outline">目录</Tabs.Tab>
						</Tabs.List>
					</div>
					<div className="plx-pluginWorkbench__viewBody">
						<Tabs.Panel value="inspect" className="plx-paneTabs__panel">
							<div className="plx-pluginWorkbench__contextScroll">
								<Stack className="plx-pluginWorkbench__contextStack">
									{Array.from({ length: 50 }, (_, i) => (
										<div key={i} style={{ padding: 20, border: '1px solid #aaa' }}>
											Overview card {i}
										</div>
									))}
								</Stack>
							</div>
						</Tabs.Panel>
						<Tabs.Panel value="outline" className="plx-paneTabs__panel">
							<div className="plx-pluginWorkbench__assistHost">
								<div className="plx-pluginWorkbench__assistSection">
									<OutlineNavigator
										anchors={Array.from({ length: 100 }, (_, i) => ({
											id: `heading-${i}`,
											label: `Heading ${i}`,
											depth: 1,
										}))}
										activeId={active}
										onSelect={setActive}
										placeholder="搜索标题"
										emptyLabel="No matches"
									/>
								</div>
							</div>
						</Tabs.Panel>
					</div>
				</Tabs>
			</div>
		</MantineProvider>
	)
}
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<App />)
