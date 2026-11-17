# Theme implementation

Visual constraints live in [color-design.md](../../color-design.md). This directory owns the Shell side of the theme, not a parallel styling policy.

| Location                    | Responsibility                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@pluxel/workbench/mantine` | Public theme structure shared with Plugin renderers: scale, fonts, colour names, component defaults   |
| `accent/`                   | Accent presets and persistence keys                                                                   |
| `core/`                     | Palette math, neutral layers, interaction states and CSS variables; `themeModel.ts` owns the contract |
| `mantine/`                  | Applies the selected accent to the public theme                                                       |
| `react/`                    | Hooks and theme controls                                                                              |
| `index.ts`                  | App-facing exports                                                                                    |

`src/styles/theme/_primitives.scss` is limited to app defaults. Feature-specific colours use Mantine variables or the few `--plx-*` tokens through Mantine props or local styles.
