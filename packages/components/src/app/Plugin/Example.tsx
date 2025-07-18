import React from 'react'
import { Box, Title, Text } from '@mantine/core'
import Plugin from './Plugin'
import type { PluginProps } from './Plugin'

export function ExamplePage() {
	const pluginInfo: PluginProps['info'] = {
		name: 'AwesomePlugin',
		description: 'This plugin provides awesome features for your app.',
		author: 'Jane Doe',
		version: '2.5.1',
		info: [
			{ label: 'Category', value: 'Utilities' },
			{ label: 'Size', value: '2 KB' },
		],
	}
	const links = [
		{ label: 'GitHub Repo', url: 'https://github.com/janedoe/awesome-plugin' },
		{ label: 'Documentation', url: 'https://janedoe.github.io/awesome-plugin' },
	]
	const license = {
		name: 'MIT License',
		url: 'https://opensource.org/licenses/MIT',
	}
	const tocRecords = [
		{ value: 'introduction', label: 'Introduction' },
		{ value: 'features', label: 'Features' },
		{
			value: 'installation',
			label: 'Installation',
			children: [
				{ value: 'prerequisites', label: 'Prerequisites' },
				{ value: 'steps', label: 'Steps' },
			],
		},
	]

	return (
		<Plugin
			info={pluginInfo}
			links={links}
			license={license}
			tocRecords={tocRecords}
		>
			<Box>
				<Title id="introduction" order={4} mb="xs">
					Introduction
				</Title>
				<Text mb="md">
					AwesomePlugin makes your life easier by providing X, Y, and Z.
				</Text>

				<Title id="features" order={5} mb="xs">
					Features
				</Title>
				<Text mb="md">
					- X functionality
					<br />- Y improvements
					<br />- Z integrations
				</Text>

				<Title id="installation" order={5} mb="xs">
					Installation
				</Title>
				<Title id="prerequisites" order={6} mb="xs">
					Prerequisites
				</Title>
				<Text mb="sm">Node.js &gt;=14</Text>
				<Title id="steps" order={6} mb="xs">
					Steps
				</Title>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text>npm install awesome-plugin</Text>
				<Text mb="sm">Node.js &gt;=14</Text>
				<Title id="steps" order={6} mb="xs">
					Steps
				</Title>
				<Text>npm install awesome-plugin</Text>
				<Text mb="sm">Node.js &gt;=14</Text>
				<Title id="steps" order={6} mb="xs">
					Steps
				</Title>
				<Text>npm install awesome-plugin</Text>
				<Text mb="sm">Node.js &gt;=14</Text>
				<Title id="steps" order={6} mb="xs">
					Steps
				</Title>
				<Text>npm install awesome-plugin</Text>
				<Text mb="sm">Node.js &gt;=14</Text>
				<Title id="steps" order={6} mb="xs">
					Steps
				</Title>
				<Text>npm install awesome-plugin</Text>
			</Box>
		</Plugin>
	)
}
