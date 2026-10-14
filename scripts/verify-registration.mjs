/**
 * 用「从 dsh-tools 源码抄下来的约束」在本地校验插件注册的每个工具定义。
 *
 * 这些规则来自 @deepseek-ai/dsh-tools 的 register() 与 json-schema.ts：
 *   - output 必须是 { schema, render, presentationMeta? }，render 必须是函数
 *   - output.schema 必须属于受支持的 JSON Schema 子集：
 *     只允许 type / oneOf / properties / required / additionalProperties / items / enum / const
 *     + 注解 description / title / default / examples；
 *     纯注解 schema（没有 type 也没有 oneOf）表示「任意 JSON」，是合法写法
 *   - 名字不得是保留的 run_code
 *   - 工具名不得重复
 *
 * 它不能替代真实宿主里的加载验证，但能在交付前挡住最常见的「注册即抛错」。
 *
 * 运行：node scripts/verify-registration.mjs
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

/** 等价于 assertSupportedJsonSchema 的检查，返回违规列表。 */
function checkSchema(node, path, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} 必须是 schema 对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(`${path}.${key} 不是受支持的关键字`)
  }
  if ('description' in node && typeof node.description !== 'string') {
    violations.push(`${path}.description 必须是字符串`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${path} 不能同时声明 type 与 oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} 需要先声明 type 或 oneOf`)
    }
    return
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf 至少需要两个分支`)
      return
    }
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} 不能与 oneOf 并列`)
    }
    node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, violations))
    return
  }
  if (!SCHEMA_TYPES.has(node.type)) {
    violations.push(`${path}.type 必须是单一类型字符串（不支持 type 数组）`)
    return
  }
  const allowedFor = {
    properties: ['object'], required: ['object'], additionalProperties: ['object'],
    items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(allowedFor)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      violations.push(`${path}.${key} 不能出现在 type="${node.type}" 上`)
    }
  }
  if (node.type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (typeof node.properties !== 'object' || node.properties === null) {
        violations.push(`${path}.properties 必须是 schema 对象`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          checkSchema(child, `${path}.properties.${key}`, violations)
        }
      }
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some(entry => typeof entry !== 'string')) {
        violations.push(`${path}.required 必须是字符串数组`)
      } else {
        const declared = node.properties ?? {}
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) violations.push(`${path}.required 里的 "${key}" 未在 properties 中声明`)
        }
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    checkSchema(node.items, `${path}.items`, violations)
  }
}

await runner.test('每个工具定义都满足 dsh-tools 的注册约束', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})

  assertNonEmpty(tools, '必须注册至少一个工具')

  const names = new Set()
  for (const [name, definition] of tools) {
    if (name === 'run_code') throw new Error('run_code 是保留名，不得注册')
    if (names.has(name)) throw new Error(`工具名重复：${name}`)
    names.add(name)

    if (typeof definition.description !== 'string' || definition.description.trim() === '') {
      throw new Error(`${name}: description 必须是非空字符串`)
    }
    if (typeof definition.execute !== 'function') throw new Error(`${name}: execute 必须是函数`)

    const output = definition.output
    if (output === undefined || typeof output !== 'object') throw new Error(`${name}: 必须声明 output`)
    if (typeof output.render !== 'function') throw new Error(`${name}: output.render 必须是函数`)
    if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
      throw new Error(`${name}: output.presentationMeta 必须是函数`)
    }

    const outputViolations = []
    checkSchema(output.schema, 'output.schema', outputViolations)
    if (outputViolations.length > 0) throw new Error(`${name}: ${outputViolations.join('；')}`)

    if (definition.parameters === undefined || definition.parameters.type !== 'object') {
      throw new Error(`${name}: parameters 必须是 object 根的 JSON Schema`)
    }
    if (definition.parameters.additionalProperties !== undefined
      && typeof definition.parameters.additionalProperties !== 'boolean') {
      throw new Error(`${name}: parameters.additionalProperties 必须是布尔值`)
    }
    if (definition.timeoutMs !== undefined
      && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
      throw new Error(`${name}: timeoutMs 必须是正有限数`)
    }
  }
})

await runner.test('output.render 对典型返回值产出合法 content blocks', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})

  const samples = [
    { ok: true, files: [{ code: 'M', path: 'a.txt' }] },
    '纯文本结果',
    null,
    [{ ok: true }],
  ]
  for (const [name, definition] of tools) {
    for (const sample of samples) {
      const blocks = definition.output.render({}, sample)
      if (!Array.isArray(blocks)) throw new Error(`${name}: render 必须返回数组`)
      for (const block of blocks) {
        if (block?.type !== 'text' || typeof block.text !== 'string') {
          throw new Error(`${name}: content block 必须是 { type: 'text', text: string }`)
        }
      }
    }
  }
})

await runner.test('parameters 必须是可无损 JSON 序列化的（模型 schema 投影要求）', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})
  for (const [name, definition] of tools) {
    let snapshot
    try {
      snapshot = JSON.parse(JSON.stringify(definition.parameters))
    } catch (error) {
      throw new Error(`${name}: parameters 无法无损序列化（${error.message}）`)
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(definition.parameters)) {
      throw new Error(`${name}: parameters 序列化后不一致（可能含 undefined / 函数）`)
    }
  }
})

await runner.test('cordis.patch.yml 结构与 package.json 的 dsh.bundle 声明一致', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const patchFile = pkg.dsh?.bundle?.patch
  if (typeof patchFile !== 'string') throw new Error('package.json 缺少 dsh.bundle.patch')

  const patchText = await readFile(path.join(root, patchFile.replace(/^\.\//, '')), 'utf8')
  if (!patchText.includes(`name: '${pkg.name}'`) && !patchText.includes(`name: "${pkg.name}"`)) {
    throw new Error(`patch 文件没有插入名为 ${pkg.name} 的插件行`)
  }
  if (!/^- insert:/m.test(patchText)) throw new Error('patch 文件缺少 insert 段')
  if (pkg.main !== 'src/index.js') throw new Error(`package.json main 应为 src/index.js，实际 ${pkg.main}`)
  if (pkg.type !== 'module') throw new Error('package.json 必须是 ESM（type: module）')
})

function assertNonEmpty(tools, message) {
  if (tools.size === 0) throw new Error(message)
}

runner.finish()
