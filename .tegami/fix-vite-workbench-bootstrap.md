---
'@pluxel/runtime': patch
'@pluxel/runtime-dynamic': patch
'@pluxel/runtime-static': patch
---

# Fix Vite Workbench bootstrap

Run development Workbench HTML through the active Vite plugin pipeline instead of assuming React Refresh is installed, keep the Vite process working directory stable across dynamic host generations, pin the complete federated producer file closure so remote-entry chunks remain loadable, and ensure the session gate renders inside its Mantine provider.
