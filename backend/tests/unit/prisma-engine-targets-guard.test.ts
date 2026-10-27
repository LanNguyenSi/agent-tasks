// Guard: the backend prod image must carry a Prisma query engine for both
// x64 and arm64 (openssl 3). Without the arm64 target the image builds on an
// Apple Silicon host but crash-loops at start, and without openssl in the
// build stage `native` resolves to openssl-1.1.x, which the prod image
// (openssl 3) cannot load.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDir = join(__dirname, '..', '..')

function binaryTargets(schema: string): string[] {
  const m = schema.match(/binaryTargets\s*=\s*\[([^\]]*)\]/)
  if (!m) throw new Error('binaryTargets not found in schema.prisma')
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

function buildStage(dockerfile: string): string {
  const m = dockerfile.match(/^FROM base AS build\n([\s\S]*?)(?=^FROM )/m)
  if (!m) throw new Error('build stage not found in backend/Dockerfile')
  return m[1]
}

describe('prisma engine targets', () => {
  const schema = readFileSync(join(backendDir, 'prisma', 'schema.prisma'), 'utf8')
  const dockerfile = readFileSync(join(backendDir, 'Dockerfile'), 'utf8')

  it('generates engines for x64 and arm64 openssl 3', () => {
    const targets = binaryTargets(schema)
    expect(targets).toContain('debian-openssl-3.0.x')
    expect(targets).toContain('linux-arm64-openssl-3.0.x')
  })

  it('installs openssl in the build stage that runs prisma generate', () => {
    const stage = buildStage(dockerfile)
    expect(stage).toMatch(/apt-get install -y openssl/)
    expect(stage.indexOf('apt-get install')).toBeLessThan(stage.indexOf('db:generate'))
  })
})
