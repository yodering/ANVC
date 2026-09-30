---
description: Make this repository's anvc records travel with git push and fetch
---
Run this command and show the user its output:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init --repo "$(git rev-parse --show-toplevel)"
```
