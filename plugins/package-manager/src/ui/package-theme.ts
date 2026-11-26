// Each role selects a Workbench/Mantine variable and a portable fallback for provider-free embeds.
export const packageColors = {
	canvas: ['--mantine-color-body', '#ffffff', '--mantine-color-body', '#151619'],
	surface: ['--mantine-color-default', '#f7f8f9', '--mantine-color-default', '#1b1c20'],
	border: [
		'--mantine-color-default-border',
		'#d6d9de',
		'--mantine-color-default-border',
		'#2e3035',
	],
	ink: ['--mantine-color-text', '#1b1e24', '--mantine-color-text', '#e4e5e9'],
	muted: ['--mantine-color-gray-7', '#4a4f58', '--mantine-color-gray-4', '#b4b9c1'],
	control: ['--mantine-color-gray-6', '#646a75', '--mantine-color-gray-5', '#8b909a'],
	accent: ['--mantine-color-brand-8', '#1a4975', '--mantine-color-brand-3', '#bed9ff'],
	positive: ['--mantine-color-teal-8', '#005045', '--mantine-color-teal-3', '#9be5d4'],
	error: ['--mantine-color-red-8', '#73332f', '--mantine-color-red-3', '#ffcbc6'],
	filled: [
		'--mantine-primary-color-filled',
		'#36618e',
		'--mantine-primary-color-filled',
		'#36618e',
	],
	'on-filled': [
		'--mantine-primary-color-contrast',
		'#ffffff',
		'--mantine-primary-color-contrast',
		'#ffffff',
	],
} as const

export const packageThemeStyles = `
:is(.plx-package-ui,.plx-marketplace) {
	${Object.entries(packageColors)
		.map(
			([role, [lightToken, light, darkToken, dark]]) =>
				`--pm-${role}: light-dark(var(${lightToken}, ${light}), var(${darkToken}, ${dark}));`,
		)
		.join('\n')}
	--pm-accent-soft: color-mix(in srgb,var(--pm-accent) 9%,var(--pm-canvas));
	--pm-positive-soft: color-mix(in srgb,var(--pm-positive) 9%,var(--pm-canvas));
	--pm-error-soft: color-mix(in srgb,var(--pm-error) 9%,var(--pm-canvas));
	--pm-mono: var(--mantine-font-family-monospace,ui-monospace, SFMono-Regular, Consolas, monospace);
	--pm-radius: var(--mantine-radius-sm,6px);
	--pm-font: var(--mantine-font-family,system-ui,sans-serif);
}
:is(.plx-package-ui,.plx-marketplace)[data-color-scheme="light"] {color-scheme:light}
:is(.plx-package-ui,.plx-marketplace)[data-color-scheme="dark"] {color-scheme:dark}
:is(.plx-package-ui,.plx-marketplace)[data-color-scheme="auto"] {color-scheme:light dark}
.plx-package-ui {color:var(--pm-ink);background:var(--pm-canvas);font-family:var(--pm-font);}
.plx-package-manager {
	--mantine-color-dimmed: var(--pm-muted); --mantine-color-placeholder: var(--pm-muted);
	--mantine-color-anchor:var(--pm-accent);
}
.plx-package-manager :is(.mantine-Input-input,.mantine-Checkbox-input):not(:disabled,[data-error]) {border-color:var(--pm-control)}
.plx-package-manager :is(button,input,select,textarea,a,summary):focus-visible {outline:2px solid var(--pm-accent); outline-offset:2px}
`
