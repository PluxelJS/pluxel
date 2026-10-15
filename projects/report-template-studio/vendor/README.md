# Worksplit branch artifacts

These two local package archives are built from [PluxelJS/split-like-vscode](https://github.com/PluxelJS/split-like-vscode/tree/eff5b57e593ed9c8df3edefcc2886775b9886b45), branch `refactor/flexlayout-tanstack`, commit `eff5b57e593ed9c8df3edefcc2886775b9886b45`.

Regenerate with `vp run @report-template-studio/app#prepare:worksplit`. The script builds and packs the upstream packages in a temporary checkout. The existing root `vendor/split-like-vscode` and Pluxel Workbench remain independent. Both archives are necessary; upstream uses the same package names and version as its old API.

To build from a local Git repository, run `vp run @report-template-studio/app#prepare:worksplit --source /absolute/path/to/split-like-vscode` from the Pluxel root. Both modes fetch the pinned revision and build in a temporary checkout; uncommitted source edits are not packed. Run `vp install --ignore-scripts` after regeneration to update the archive integrity in the lockfile.

Packaging-only adjustment: the React archive declares `@worksplit/core@0.1.0` as a peer instead of an unpublished registry dependency. Studio explicitly supplies its sibling archive. Source and compiled code are unchanged; this also prevents resolution to Pluxel's older workspace package with the same name/version.
