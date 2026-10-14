/**
 * Validate every tool definition the plugin registers, locally, against "the constraints copied from
 * the dsh-tools source".
 *
 * These rules come from @deepseek-ai/dsh-tools' register() and json-schema.ts:
 *   - output must be { schema, render, presentationMeta? }, and render must be a function
 *   - output.schema must belong to the supported JSON Schema subset:
 *     only type / oneOf / properties / required / additionalProperties / items / enum / const
 *     + the annotations description / title / default / examples;
 *     an annotation-only schema (neither type nor oneOf) means "any JSON" and is a legal form
 *   - the name must not be the reserved run_code
 *   - tool names must not repeat
 *
 * It cannot replace the loading validation in the real host, but it blocks the most common
 * "throws as soon as it is registered" before delivery.
 *
 * Run: node scripts/verify-registration.mjs
 */

import { fileURLToPath } from 'node:url'
import { createRunner, fakeContext, loadPlugin } from '../test/harness.mjs'

const runner = createRunner('verify-registration.mjs')

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** Equivalent to the assertSupportedJsonSchema check; returns the list of violations. */
function checkSchema(node, path, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(`${path}.${key} is not a supported keyword`)
  }
  if ('description' in node && typeof node.description !== 'string') {
    violations.push(`${path}.description must be a string`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare type and oneOf at the same time`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf to be declared first`)
    }
    return
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf needs at least two branches`)
      return
    }
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} cannot sit alongside oneOf`)
    }
    node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, violations))
    return
  }
  if (!SCHEMA_TYPES.has(node.type)) {
    violations.push(`${path}.type must be a single type string (type arrays are not supported)`)
    return
  }
  const allowedFor = {
    properties: ['object'], required: ['object'], additionalProperties: ['object'],
    items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(allowedFor)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      violations.push(`${path}.${key} cannot appear on type="${node.type}"`)
    }
  }
  if (node.type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (typeof node.properties !== 'object' || node.properties === null) {
        violations.push(`${path}.properties must be a schema object`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          checkSchema(child, `${path}.properties.${key}`, violations)
        }
      }
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some(entry => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else {
        const declared = node.properties ?? {}
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) violations.push(`"${key}" in ${path}.required is not declared in properties`)
        }
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    checkSchema(node.items, `${path}.items`, violations)
  }
}

await runner.test('every tool definition satisfies the dsh-tools registration constraints', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})

  assertNonEmpty(tools, 'at least one tool must be registered')

  const names = new Set()
  for (const [name, definition] of tools) {
    if (name === 'run_code') throw new Error('run_code is a reserved name and must not be registered')
    if (names.has(name)) throw new Error(`duplicate tool name: ${name}`)
    names.add(name)

    if (typeof definition.description !== 'string' || definition.description.trim() === '') {
      throw new Error(`${name}: description must be a non-empty string`)
    }
    if (typeof definition.execute !== 'function') throw new Error(`${name}: execute must be a function`)

    const output = definition.output
    if (output === undefined || typeof output !== 'object') throw new Error(`${name}: output must be declared`)
    if (typeof output.render !== 'function') throw new Error(`${name}: output.render must be a function`)
    if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
      throw new Error(`${name}: output.presentationMeta must be a function`)
    }

    const outputViolations = []
    checkSchema(output.schema, 'output.schema', outputViolations)
    if (outputViolations.length > 0) throw new Error(`${name}: ${outputViolations.join('; ')}`)

    if (definition.parameters === undefined || definition.parameters.type !== 'object') {
      throw new Error(`${name}: parameters must be a JSON Schema with an object root`)
    }
    if (definition.parameters.additionalProperties !== undefined
      && typeof definition.parameters.additionalProperties !== 'boolean') {
      throw new Error(`${name}: parameters.additionalProperties must be a boolean`)
    }
    if (definition.timeoutMs !== undefined
      && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
      throw new Error(`${name}: timeoutMs must be a positive finite number`)
    }
  }
})

await runner.test('output.render produces valid content blocks for typical return values', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})

  const samples = [
    { ok: true, files: [{ code: 'M', path: 'a.txt' }] },
    'a plain-text result',
    null,
    [{ ok: true }],
  ]
  for (const [name, definition] of tools) {
    for (const sample of samples) {
      const blocks = definition.output.render({}, sample)
      if (!Array.isArray(blocks)) throw new Error(`${name}: render must return an array`)
      for (const block of blocks) {
        if (block?.type !== 'text' || typeof block.text !== 'string') {
          throw new Error(`${name}: a content block must be { type: 'text', text: string }`)
        }
      }
    }
  }
})

await runner.test('parameters must be losslessly JSON-serializable (a model schema projection requirement)', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})
  for (const [name, definition] of tools) {
    let snapshot
    try {
      snapshot = JSON.parse(JSON.stringify(definition.parameters))
    } catch (error) {
      throw new Error(`${name}: parameters cannot be serialized losslessly (${error.message})`)
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(definition.parameters)) {
      throw new Error(`${name}: parameters differ after serialization (may contain undefined / functions)`)
    }
  }
})

await runner.test('the cordis.patch.yml structure matches the dsh.bundle declaration in package.json', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const patchFile = pkg.dsh?.bundle?.patch
  if (typeof patchFile !== 'string') throw new Error('package.json is missing dsh.bundle.patch')

  const patchText = await readFile(path.join(root, patchFile.replace(/^\.\//, '')), 'utf8')
  if (!patchText.includes(`name: '${pkg.name}'`) && !patchText.includes(`name: "${pkg.name}"`)) {
    throw new Error(`the patch file does not insert a plugin line named ${pkg.name}`)
  }
  if (!/^- insert:/m.test(patchText)) throw new Error('the patch file is missing the insert section')
  if (pkg.main !== 'src/index.js') throw new Error(`package.json main should be src/index.js, actual ${pkg.main}`)
  if (pkg.type !== 'module') throw new Error('package.json must be ESM (type: module)')
})

function assertNonEmpty(tools, message) {
  if (tools.size === 0) throw new Error(message)
}

runner.finish()
