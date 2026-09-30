---
description: Open this repository's work log in the browser, or in the desktop app with --desktop
argument-hint: "[--desktop] [--no-browser]"
---
Run this command and show the user its output:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" open --repo "$(git rev-parse --show-toplevel)"
```

Arguments: $ARGUMENTS

Add to the command each of `--desktop` and `--no-browser` that the arguments include. Leave out anything else in them, and never paste them into the command.
