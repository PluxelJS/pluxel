---
'@pluxel/runtime-dynamic': patch
---

Prepare eager runtime services before starting the initial dynamic plugin graph, so hosts that enable Vault and other eager services can safely use them during plugin startup. Dynamic host shutdown now also stops the committed plugin graph before disposing root services, ensuring plugin effects and resources are released.
