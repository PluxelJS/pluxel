---
packages:
  '@pluxel/playwright': major
  '@pluxel/fiscal-ticket': major
---

# Add external browser connections and fiscal ticket verification

Introduce a Playwright capability that connects to externally operated browsers over CDP or the native Playwright protocol without installing or launching a browser, and a separate fiscal electronic ticket verification plugin using that capability. Keep browser contexts scoped to their consumers and plugin lifetimes, and keep browser credentials in Vault.

Fiscal verification exposes explicit results and manual challenge handling rather than treating transport success as ticket validity. Live platform and Lightpanda interoperability require deployment-specific verification.
