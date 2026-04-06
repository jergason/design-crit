import * as fs from 'node:fs'
import * as path from 'node:path'

interface PanelPreset {
  name: string
  description: string
  personas: string[]
  roundLimit: number
}

const PANELS_DIR = path.join(import.meta.dirname, '..', 'panels')

export function resolvePanel(input: string | undefined): {
  personas: string[]
  roundLimit?: number
} {
  if (!input) {
    return { personas: ['pragmatist', 'scope-hawk', 'security-paranoiac'] }
  }

  // try loading as a preset name
  const presetPath = path.join(PANELS_DIR, `${input}.json`)
  if (fs.existsSync(presetPath)) {
    const preset: PanelPreset = JSON.parse(fs.readFileSync(presetPath, 'utf-8'))
    return { personas: preset.personas, roundLimit: preset.roundLimit }
  }

  // otherwise treat as comma-separated persona list
  return { personas: input.split(',').map((s) => s.trim()) }
}

export function listPresets(): PanelPreset[] {
  if (!fs.existsSync(PANELS_DIR)) return []
  return fs
    .readdirSync(PANELS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PANELS_DIR, f), 'utf-8')))
}
