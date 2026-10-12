# Worksplit branch artifacts

These two local package archives are built from [PluxelJS/split-like-vscode](https://github.com/PluxelJS/split-like-vscode/tree/7768656250cea1e6c32d04373e3eccd5ad49f4fa), branch `refactor/flexlayout-tanstack`, commit `7768656250cea1e6c32d04373e3eccd5ad49f4fa`.

Regenerate with `pnpm --filter @report-template-studio/app prepare:worksplit`. The script builds and packs the upstream packages in a temporary checkout. The existing root `vendor/split-like-vscode` and Pluxel Workbench remain independent. Both archives are necessary; upstream uses the same package names and version as its old API.

Packaging-only adjustment: the React archive declares `@worksplit/core@0.1.0` as a peer instead of an unpublished registry dependency. Studio explicitly supplies its sibling archive. Source and compiled code are unchanged; this also prevents resolution to Pluxel's older workspace package with the same name/version.
