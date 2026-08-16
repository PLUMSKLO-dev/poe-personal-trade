import fs from 'node:fs'
import path from 'node:path'

const source = process.argv[2]
const destination = process.argv[3]
if (!source || !destination) throw new Error('Usage: node generate-stat-directions.mjs <stats.ndjson> <output.ts>')

const directions = {}
const matchers = []
for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
  if (!line) continue
  const record = JSON.parse(line)
  const stats = Array.isArray(record.stats) ? record.stats : [record]
  for (const stat of stats) {
    for (const ids of Object.values(stat.trade?.ids ?? {})) {
      for (const rawId of ids) {
        const id = rawId.startsWith('{') ? rawId.slice(rawId.indexOf('}') + 1) : rawId
        directions[id] ??= {
          better: stat.better,
          ...(stat.trade?.inverted ? { inverted: true } : {})
        }
      }
    }
    for (const matcher of stat.matchers ?? []) {
      matchers.push({
        template: matcher.string,
        tradeIds: stat.trade?.ids ?? {},
        better: stat.better,
        ...(stat.trade?.inverted ? { inverted: true } : {}),
        ...(matcher.negate ? { negate: true } : {}),
        ...(typeof matcher.value === 'number' ? { fixedValue: matcher.value } : {})
      })
    }
  }
}

const output = `// Generated from Awakened PoE Trade's MIT-licensed stats dataset.\n` +
  `// See THIRD_PARTY_NOTICES.txt. Do not edit manually.\n` +
  `export const statDirections = JSON.parse(${JSON.stringify(JSON.stringify(directions))}) as Record<string, { better: -1 | 0 | 1; inverted?: true }>;\n` +
  `export interface GeneratedStatMatcher { template: string; tradeIds: Record<string, string[]>; better: -1 | 0 | 1; inverted?: true; negate?: true; fixedValue?: number }\n` +
  `export const generatedStatMatchers = JSON.parse(${JSON.stringify(JSON.stringify(matchers))}) as GeneratedStatMatcher[];\n`
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.writeFileSync(destination, output)
