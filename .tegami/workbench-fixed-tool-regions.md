---
packages:
  '@pluxel/workbench': patch
---

# Restore native tool borders

Use native left, right and bottom Borders, with native click-to-collapse behavior and recovery strips. Bottom is empty by default and appears only for the active plugin's declared extensions. Remove central bottom height emulation. Keep document docking in the center and scope tool availability to the active plugin. Use layout storage revision 7 for independent native panel tabs; plugin groups and business settings are unchanged.

# Separate official tools from plugin panels

Keep official plugin information and recent logs inside the fixed official tool. Open declared plugin panels as independent, closable native tabs, reorderable within their declared region. Discover and reopen them through the official extension directory or entry search. Preserve each owner’s unclosed panel layout across context switches and reload, without automatically reopening closed panels or persisting live renderer resources.
