---
description: Turn ANVC off in this repository
---
Run this command and show the user its output:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" off --repo "$(git rev-parse --show-toplevel)"
```
