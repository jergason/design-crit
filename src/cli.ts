#!/usr/bin/env tsx
import meow from 'meow'
import { render } from 'ink'
import React from 'react'
import { App } from './ui/app.js'

const cli = meow(
  `
  Usage
    $ design-crit <design-doc.md>

  Options
    --panel, -p    Panel preset name or comma-separated personas
                   Presets: pre-rfc, security-audit, ship-or-kill, greenfield, full-panel
                   Default: pragmatist,scope-hawk,security-paranoiac
    --rounds, -r   Max rounds (default: 2)
    --codebase, -c Path to codebase for agent exploration
    --debug, -d    Verbose logging (SSE events, timing, session IDs)

  Examples
    $ design-crit docs/my-design.md
    $ design-crit docs/my-design.md --panel pre-rfc
    $ design-crit docs/my-design.md --panel security-paranoiac,pragmatist --rounds 3
`,
  {
    importMeta: import.meta,
    flags: {
      panel: { type: 'string', shortFlag: 'p' },
      rounds: { type: 'number', shortFlag: 'r', default: 2 },
      codebase: { type: 'string', shortFlag: 'c' },
      debug: { type: 'boolean', shortFlag: 'd', default: false },
    },
  },
)

const docPath = cli.input[0] ?? undefined

const { waitUntilExit } = render(
  React.createElement(App, {
    docPath,
    panel: cli.flags.panel,
    rounds: cli.flags.rounds,
    codebasePath: cli.flags.codebase,
    debug: cli.flags.debug,
  }),
)

waitUntilExit().then(() => process.exit(0))
