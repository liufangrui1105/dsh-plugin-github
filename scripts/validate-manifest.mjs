/**
 * Validate the package manifest and the bundle patch together.
 *
 * These are the things the host and the community directory depend on, and each
 * one fails silently when it is wrong: a patch row whose `name` does not equal the
 * package name activates nothing, a `dsh.bundle` that is missing makes the package
 * uninstallable, and a patch file left out of `files` disappears from a tarball.
 * Running it locally means the failure shows up here instead of in someone's
 * profile.
 *
 * Run: node scripts/validate-manifest.mjs
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
const readText = async file => readFile(path.join(root, file), 'utf8')

const pkg = await readJson('package.json')
const index = await readText('src/index.js')

// --- package.json -----------------------------------------------------------------

if (typeof pkg.name !== 'string' || pkg.name.trim() === '') problems.push('package.json: name is required')
if (pkg.type !== 'module') problems.push('package.json: type must be "module" (the plugin is ESM)')
if (typeof pkg.license !== 'string' || pkg.license === '') problems.push('package.json: license is required')
if (pkg.repository?.url === undefined) problems.push('package.json: repository.url is required so npm can link back to the source')

for (const script of ['prepare', 'prepack', 'install', 'postinstall']) {
  if (pkg.scripts?.[script] !== undefined) {
    // A git install fetches sources, and the mere presence of these scripts makes npm
    // rebuild the dependency on every install. This package ships plain JavaScript, so
    // it must not define any of them.
    problems.push(`package.json: scripts.${script} must not be defined (the sources are the artifact set)`)
  }
}

// --- dsh bundle manifest ----------------------------------------------------------

const patchFile = pkg.dsh?.bundle?.patch
if (typeof patchFile !== 'string' || patchFile === '') {
  problems.push('package.json: dsh.bundle.patch is required (it is what makes the package installable)')
} else {
  const relative = patchFile.replace(/^\.\//, '')
  if (!(pkg.files ?? []).some(entry => entry === relative || entry.startsWith(`${relative.split('/')[0]}/`))) {
    problems.push(`package.json: "${relative}" must be listed in files, or it will not ship in a tarball`)
  }

  let patch
  try {
    patch = await readText(relative)
  } catch {
    problems.push(`package.json: dsh.bundle.patch points at ${relative}, which does not exist`)
  }

  if (patch !== undefined) {
    // The row's name must equal the package name, and the id must equal the module's
    // exported `name`; a mismatch silently leaves the tool unregistered.
    const quoted = [`'${pkg.name}'`, `"${pkg.name}"`]
    if (!quoted.some(form => patch.includes(form))) {
      problems.push(`cordis.patch.yml: the plugin row's name must be exactly ${pkg.name}`)
    }
    const hasInsert = /^- insert:/m.test(patch)
    if (!hasInsert) problems.push('cordis.patch.yml: expected an `- insert:` block')

    // The inserted row is a YAML sequence item (`    - id: …`), so require the dash:
    // that skips both comments and any `id:` nested deeper in a plugin's config block.
    const declaredId = patch.match(/^[ \t]*-[ \t]+id:[ \t]*([^\s#]+)/m)?.[1]
    if (declaredId === undefined) problems.push('cordis.patch.yml: the inserted row needs an `- id:` entry')

    const moduleName = index.match(/export const name = '([^']+)'/)?.[1]
    if (moduleName === undefined) {
      problems.push('src/index.js: could not find `export const name`')
    } else if (declaredId !== undefined && declaredId !== moduleName) {
      problems.push(`cordis.patch.yml: row id "${declaredId}" must equal the plugin's exported name "${moduleName}"`)
    }
  }
}

// --- the module the patch points at ----------------------------------------------

if (!/export (async )?function apply\s*\(/.test(index)) problems.push('src/index.js: must export apply()')
if (!/export const inject\s*=/.test(index)) problems.push('src/index.js: must declare inject so the tool registry is ready')

// --- report -----------------------------------------------------------------------

if (problems.length === 0) {
  console.log(`manifest OK: ${pkg.name}@${pkg.version}, patch ${patchFile}, plugin id "${index.match(/export const name = '([^']+)'/)?.[1]}"`)
} else {
  console.error(`manifest has ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}
