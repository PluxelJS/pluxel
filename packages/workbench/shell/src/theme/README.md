# Theme implementation

Visual constraints live in [color-design.md](../../color-design.md). This directory owns the implementation, not a parallel styling policy.

| Location   | Responsibility                                                                           |
| ---------- | ---------------------------------------------------------------------------------------- |
| `accent/`  | Accent presets and persistence keys                                                      |
| `core/`    | Palette math, semantic tokens and CSS variables; `themeModel.ts` owns the token contract |
| `mantine/` | Direct Mantine configuration, typings and existing CJK text normalization                |
| `react/`   | Hooks and theme controls                                                                 |
| `index.ts` | App-facing exports                                                                       |

`src/styles/theme/_primitives.scss` is limited to app defaults and neutral shared panel surfaces. Feature-specific colors use existing tokens through Mantine props or local styles.
