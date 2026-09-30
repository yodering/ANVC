---
description: Turn ANVC on in this repository
---
Run this command and show the user its output:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" on --repo "$(git rev-parse --show-toplevel)"
```
