import { fileURLToPath as _fileURLToPath, pathToFileURL } from 'url'
import { dirname } from 'path'
import { realpathSync, promises as fsp } from 'fs'
import { createRequire, builtinModules } from 'module'
import { moduleResolve } from 'import-meta-resolve'

// CommonJS

export function createCommonJS (url) {
  const __filename = fileURLToPath(url)
  const __dirname = dirname(__filename)

  // Lazy require
  let _nativeRequire
  const getNativeRequire = () => _nativeRequire || (_nativeRequire = createRequire(url))
  function require (id) { return getNativeRequire()(id) }
  require.resolve = (id, options) => getNativeRequire().resolve(id, options)

  return {
    __filename,
    __dirname,
    require
  }
}

// Resolve

const DEFAULT_CONDITIONS_SET = new Set(['node', 'import'])
const BUILُTIN_MODULES = new Set(builtinModules)
const DEFAULT_URL = pathToFileURL(process.cwd())
const DEFAULT_EXTENSIONS = ['.mjs', '.cjs', '.js', '.json']
const NOT_FOUND_ERRORS = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT', 'MODULE_NOT_FOUND'])

function _tryModuleResolve (id, url, conditions) {
  try {
    return moduleResolve(id, url, conditions)
  } catch (err) {
    if (!NOT_FOUND_ERRORS.has(err.code)) {
      throw err
    }
    return null
  }
}

function _resolve (id, opts = {}) {
  // console.log('> resolve ', id, 'from', opts.url)

  // Skip if already has a protocol
  if (/(node|data|http|https):/.test(id)) {
    return id
  }

  // Skip builtins
  if (BUILُTIN_MODULES.has(id)) {
    return 'node:' + id
  }

  // Defaults
  const conditionsSet = opts.conditions ? new Set(opts.conditions) : DEFAULT_CONDITIONS_SET
  const url = opts.url ? normalizeid(opts.url) : DEFAULT_URL

  // Try simple resolve
  let resolved = _tryModuleResolve(id, url, conditionsSet)

  // Try other extensions if not found
  if (!resolved) {
    for (const prefix of ['', '/index']) {
      for (const ext of opts.extensions || DEFAULT_EXTENSIONS) {
        resolved = _tryModuleResolve(id + prefix + ext, url, conditionsSet)
        if (resolved) { break }
      }
      if (resolved) { break }
    }
  }

  // Throw error if not found
  if (!resolved) {
    const err = new Error(`Cannot find module ${id} imported from ${url}`)
    err.code = 'ERR_MODULE_NOT_FOUND'
    throw err
  }

  // Resolve realPath and normalize slash
  const realPath = realpathSync(fileURLToPath(resolved))
  return pathToFileURL(realPath).toString()
}

export function resolveSync (id, opts) {
  return _resolve(id, opts)
}

export function resolve (id, opts) {
  return _pcall(resolveSync, id, opts)
}

export function resolvePathSync (id, opts) {
  return fileURLToPath(resolveSync(id, opts))
}

export function resolvePath (id, opts) {
  return _pcall(resolvePathSync, id, opts)
}

export function createResolve (defaults) {
  return (id, url) => {
    return resolve(id, { url, ...defaults })
  }
}

// Evaluate

const ESM_IMPORT_RE = /(?<=import .* from ['"])([^'"]+)(?=['"])|(?<=export .* from ['"])([^'"]+)(?=['"])|(?<=import\s*['"])([^'"]+)(?=['"])|(?<=import\s*\(['"])([^'"]+)(?=['"]\))/g

export async function loadModule (id, opts = {}) {
  const url = await resolve(id, opts)
  const code = await loadURL(url)
  return evalModule(code, { ...opts, url })
}

export async function evalModule (code, opts = {}) {
  const transformed = await transformModule(code, opts)
  const dataURL = toDataURL(transformed, opts)
  return import(dataURL).catch((err) => {
    err.stack = err.stack.replace(new RegExp(dataURL, 'g'), opts.url || '_mlly_eval_.mjs')
    throw err
  })
}

export async function transformModule (code, opts) {
  // Convert JSON to module
  if (opts.url && opts.url.endsWith('.json')) {
    return 'export default ' + code
  }

  // Resolve relative imports
  code = await resolveImports(code, opts)

  // Rewrite import.meta.url
  if (opts.url) {
    code = code.replace(/import\.meta\.url/g, `'${opts.url}'`)
  }

  return code
}

export async function resolveImports (code, opts) {
  const imports = Array.from(code.matchAll(ESM_IMPORT_RE)).map(m => m[0])
  if (!imports.length) {
    return code
  }

  const uniqueImports = Array.from(new Set(imports))
  const resolved = new Map()
  await Promise.all(uniqueImports.map(async (id) => {
    let url = await resolve(id, opts)
    if (url.endsWith('.json')) {
      const code = await loadURL(url)
      url = toDataURL(await transformModule(code, { url }))
    }
    resolved.set(id, url)
  }))

  const re = new RegExp(uniqueImports.map(i => `(${i})`).join('|'), 'g')
  return code.replace(re, id => resolved.get(id))
}

// Syntax Utils
const ESM_IMPORT_RE2 = /^\s*import\s*(["'\s]*(?<importString>[\w*${}\n\r\t, /]+)from\s*)?["']\s*(?<from>.*[@\w_-]+)\s*["'][^\n]*$/gm
const TYPE_ONLY_IMPORT = /import type/
const NAMED_IMPORT_RE = /\{([^}]*)\}/
const NAMED_TYPE_IMPORT_RE = /(type \{([^}]*)\}|type [^\s]+)(\s*as\s*[^\s]*)?/g
const COMMENT_RE = /(\/\/[^\n]*\n|\/\*.*\*\/)/g
const WHITESPACE_RE = /\s+/g

export function matchESMImports (code) {
  const imports = []
  for (const match of code.matchAll(ESM_IMPORT_RE2)) {
    const { 0: code, groups: { from, importString = '' } } = match

    if (code.match(TYPE_ONLY_IMPORT)) { continue }

    const cleanedImports = importString
      .replace(COMMENT_RE, '')
      .replace(NAMED_TYPE_IMPORT_RE, '')
      .replace(WHITESPACE_RE, ' ')

    const namedImports = {}
    for (const namedImport of cleanedImports.match(NAMED_IMPORT_RE)?.[1]?.split(',') || []) {
      const [, source = namedImport.trim(), importName = source] = namedImport.match(/^\s*([^\s]*) as ([^\s]*)\s*$/) || []
      if (source) {
        namedImports[source] = importName
      }
    }
    const topLevelImports = cleanedImports.replace(NAMED_IMPORT_RE, '')
    const namespacedImport = topLevelImports.match(/\* as \s*([^\s]*)/)?.[1]
    const defaultImport = topLevelImports.split(',').find(i => !i.match(/[*{}]/))?.trim() || undefined

    imports.push({
      code,
      from,
      imports: {
        defaultImport,
        namespacedImport,
        namedImports
      }
    })
  }
  return imports
}

// Utils

export function fileURLToPath (id) {
  if (typeof id === 'string' && !id.startsWith('file://')) {
    return normalizeSlash(id)
  }
  return normalizeSlash(_fileURLToPath(id))
}

export function normalizeid (id) {
  if (typeof id !== 'string') {
    id = id.toString()
  }
  if (/(node|data|http|https|file):/.test(id)) {
    return id
  }
  if (BUILُTIN_MODULES.has(id)) {
    return 'node:' + id
  }
  return 'file://' + normalizeSlash(id)
}

export async function loadURL (url) {
  const code = await fsp.readFile(fileURLToPath(url), 'utf-8')
  return code
}

export function toDataURL (code) {
  const base64 = Buffer.from(code).toString('base64')
  return `data:text/javascript;base64,${base64}`
}

function normalizeSlash (str) {
  return str.replace(/\\/g, '/')
}

function _pcall (fn, ...args) {
  try {
    return Promise.resolve(fn(...args)).catch(err => _perr(err))
  } catch (err) {
    return _perr(err)
  }
}

function _perr (_err) {
  const err = new Error(_err)
  err.code = _err.code
  Error.captureStackTrace(err, _pcall)
  return Promise.reject(err)
}
