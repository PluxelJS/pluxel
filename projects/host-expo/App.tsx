import { reloadAppAsync } from 'expo'
import { useEffect, useRef, useState } from 'react'
import { Button, ScrollView, StyleSheet, Text } from 'react-native'
import { hasInstalledPlugin, installPlugin, uninstallPlugin } from './src/installed-plugin'
import { run } from './src/run'

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export default function App() {
	const [receipt, setReceipt] = useState('')
	const [installed, setInstalled] = useState(false)
	const [busy, setBusy] = useState(true)
	const changing = useRef(false)

	useEffect(() => {
		const controller = new AbortController()
		async function inspect() {
			try {
				const value = await run(controller.signal)
				if (!controller.signal.aborted) setReceipt(JSON.stringify(value, null, 2))
			} catch (error) {
				if (!controller.signal.aborted) setReceipt(describe(error))
			} finally {
				if (!controller.signal.aborted) {
					setInstalled(hasInstalledPlugin())
					setBusy(false)
				}
			}
		}
		void inspect()
		return () => controller.abort()
	}, [])

	async function change() {
		if (changing.current) return
		changing.current = true
		setBusy(true)
		try {
			if (installed) uninstallPlugin()
			else if (!(await installPlugin())) return
			await reloadAppAsync('Apply the installed plugin selection')
		} catch (error) {
			setReceipt(describe(error))
		} finally {
			changing.current = false
			setInstalled(hasInstalledPlugin())
			setBusy(false)
		}
	}

	return (
		<ScrollView contentContainerStyle={styles.page}>
			<Text accessibilityRole="header" style={styles.title}>
				Pluxel Host
			</Text>
			<Button
				testID="change-plugin"
				title={installed ? 'Remove plugin and reload' : 'Install trusted plugin file'}
				disabled={busy}
				onPress={change}
			/>
			<Text selectable testID="receipt" style={styles.receipt}>
				{receipt}
			</Text>
		</ScrollView>
	)
}

const styles = StyleSheet.create({
	page: { paddingHorizontal: 24, paddingVertical: 56, gap: 16 },
	title: { fontSize: 28, fontWeight: '600' },
	receipt: { fontSize: 15 },
})
