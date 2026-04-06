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
    --panel, -p    Panel personas, comma-separated (default: pragmatist,scope-hawk,security-paranoiac)
    --rounds, -r   Max rounds (default: 2)
    --codebase, -c Path to codebase for agent exploration

  Examples
    $ design-crit docs/my-design.md
    $ design-crit docs/my-design.md --panel security-paranoiac,pragmatist --rounds 3
`,
  {
    importMeta: import.meta,
    flags: {
      panel: { type: 'string', shortFlag: 'p' },
      rounds: { type: 'number', shortFlag: 'r', default: 2 },
      codebase: { type: 'string', shortFlag: 'c' },
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
  }),
)

waitUntilExit().then(() => process.exit(0))
