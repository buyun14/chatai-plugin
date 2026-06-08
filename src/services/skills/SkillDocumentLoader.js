import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { chatLogger } from '../../core/utils/logger.js'

const logger = chatLogger
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', 'dist', 'build', 'coverage'])

function parseSkillMarkdown(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
    if (!match) {
        return { metadata: {}, body: content }
    }

    let metadata = {}
    try {
        const parsed = YAML.parse(match[1])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = parsed
        }
    } catch (error) {
        logger.warn(`[SkillDocumentLoader] SKILL.md frontmatter 解析失败: ${error.message}`)
    }

    return { metadata, body: content.slice(match[0].length) }
}

function resolvePath(pluginRoot, configuredPath) {
    if (!configuredPath || typeof configuredPath !== 'string') return null
    const trimmed = configuredPath.trim()
    if (!trimmed) return null
    return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(pluginRoot, trimmed)
}

function relativeToPlugin(pluginRoot, filePath) {
    const relativePath = path.relative(pluginRoot, filePath)
    if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return relativePath.replace(/\\/g, '/')
    }
    return filePath
}

function toStringList(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
    if (typeof value === 'string' && value.trim()) return [value.trim()]
    return []
}

function normalizeSearchText(value) {
    return String(value || '').toLowerCase()
}

function normalizeDocumentOptions(options = {}, config = {}) {
    return {
        selectedNames: Array.isArray(options.selectedNames)
            ? new Set(options.selectedNames.filter(Boolean).map(String))
            : null,
        mode: options.mode || config.mode || 'auto',
        contextText: normalizeSearchText(
            options.contextText || options.message || options.userMessage || options.query || ''
        )
    }
}

function matchesDocument(document, normalizedOptions) {
    const { selectedNames, mode, contextText } = normalizedOptions
    if (selectedNames && (selectedNames.has(document.name) || selectedNames.has(document.relativePath))) {
        return true
    }
    if (mode === 'explicit') return false
    if (mode === 'all') return !selectedNames
    if (!contextText) return false

    const terms = [document.name, document.description, document.relativePath, ...toStringList(document.triggers)]
        .map(normalizeSearchText)
        .filter(Boolean)

    return terms.some(term => contextText.includes(term))
}

class SkillDocumentLoader {
    constructor() {
        this.documents = []
        this.initialized = false
        this.pluginRoot = null
        this.skillsConfig = null
    }

    async init(pluginRoot, skillsConfig) {
        this.pluginRoot = pluginRoot
        this.skillsConfig = skillsConfig
        await this.load()
        this.initialized = true
        return this
    }

    async load() {
        this.documents = []
        const config = this.skillsConfig?.getDocumentSkillsConfig?.() || {}
        if (config.enabled === false) {
            return
        }

        const paths = Array.isArray(config.paths) ? config.paths : []
        const maxDepth = Number.isFinite(config.maxDepth) ? config.maxDepth : 6
        const maxFileBytes = Number.isFinite(config.maxFileBytes) ? config.maxFileBytes : 65536
        const seenFiles = new Set()

        for (const configuredPath of paths) {
            const root = resolvePath(this.pluginRoot, configuredPath)
            if (!root || !fs.existsSync(root)) continue

            for (const filePath of this.findSkillFiles(root, maxDepth)) {
                let realPath = filePath
                try {
                    realPath = fs.realpathSync(filePath)
                } catch {}
                if (seenFiles.has(realPath)) continue
                seenFiles.add(realPath)

                const document = this.readSkillFile(filePath, maxFileBytes)
                if (document) {
                    this.documents.push(document)
                }
            }
        }

        logger.debug(`[SkillDocumentLoader] 加载 SKILL.md 文档技能: ${this.documents.length} 个`)
    }

    findSkillFiles(root, maxDepth) {
        const files = []
        const stat = fs.statSync(root)
        if (stat.isFile()) {
            if (path.basename(root) === 'SKILL.md') files.push(root)
            return files
        }
        if (!stat.isDirectory()) return files

        const stack = [{ dir: root, depth: 0 }]
        while (stack.length > 0) {
            const current = stack.pop()
            if (!current || current.depth > maxDepth) continue

            let entries = []
            try {
                entries = fs.readdirSync(current.dir, { withFileTypes: true })
            } catch (error) {
                logger.debug(`[SkillDocumentLoader] 读取目录失败: ${current.dir}, ${error.message}`)
                continue
            }

            for (const entry of entries) {
                const fullPath = path.join(current.dir, entry.name)
                if (entry.isFile() && entry.name === 'SKILL.md') {
                    files.push(fullPath)
                } else if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && current.depth < maxDepth) {
                    stack.push({ dir: fullPath, depth: current.depth + 1 })
                }
            }
        }

        return files
    }

    readSkillFile(filePath, maxFileBytes) {
        try {
            const stat = fs.statSync(filePath)
            if (stat.size > maxFileBytes) {
                logger.warn(`[SkillDocumentLoader] 跳过过大的 SKILL.md: ${filePath}`)
                return null
            }

            const content = fs.readFileSync(filePath, 'utf-8')
            const { metadata, body } = parseSkillMarkdown(content)
            const directory = path.dirname(filePath)
            const name =
                typeof metadata.name === 'string' && metadata.name.trim()
                    ? metadata.name.trim()
                    : path.basename(directory)
            const description =
                typeof metadata.description === 'string' && metadata.description.trim()
                    ? metadata.description.trim()
                    : ''
            const triggers = [
                ...toStringList(metadata.triggers),
                ...toStringList(metadata.trigger),
                ...toStringList(metadata.aliases),
                ...toStringList(metadata.alias)
            ]
            const allowedTools = [
                ...toStringList(metadata.allowedTools),
                ...toStringList(metadata.allowed_tools),
                ...toStringList(metadata['allowed-tools'])
            ]
            const disallowedTools = [
                ...toStringList(metadata.disallowedTools),
                ...toStringList(metadata.disallowed_tools),
                ...toStringList(metadata['disallowed-tools'])
            ]

            return {
                name,
                description,
                triggers,
                allowedTools,
                disallowedTools,
                metadata,
                body: body.trim(),
                path: filePath,
                relativePath: relativeToPlugin(this.pluginRoot, filePath),
                directory,
                loadedAt: Date.now()
            }
        } catch (error) {
            logger.warn(`[SkillDocumentLoader] 读取 SKILL.md 失败: ${filePath}, ${error.message}`)
            return null
        }
    }

    getDocuments() {
        return this.documents.map(document => ({ ...document }))
    }

    getMatchingDocuments(options = {}) {
        const config = this.skillsConfig?.getDocumentSkillsConfig?.() || {}
        if (config.enabled === false || this.documents.length === 0) return []
        const normalizedOptions = normalizeDocumentOptions(options, config)
        return this.documents
            .filter(document => matchesDocument(document, normalizedOptions))
            .map(document => ({ ...document }))
    }

    buildInstructions(options = {}) {
        const config = this.skillsConfig?.getDocumentSkillsConfig?.() || {}
        if (config.enabled === false || this.documents.length === 0) return ''

        const maxPromptChars = Number.isFinite(options.maxPromptChars)
            ? options.maxPromptChars
            : Number.isFinite(config.maxPromptChars)
              ? config.maxPromptChars
              : 20000

        const docs = this.getMatchingDocuments(options)
        if (docs.length === 0) return ''

        const sections = [
            '【Agent Skills】',
            '以下内容来自本项目配置目录中的 SKILL.md。它们是本地文档技能说明，不是可执行工具；必须按正文说明调整任务处理方式。'
        ]

        for (const document of docs) {
            const lines = [`\n### ${document.name}`]
            if (document.description) lines.push(`说明: ${document.description}`)
            lines.push(`来源: ${document.relativePath}`)
            if (document.body) lines.push(document.body)
            sections.push(lines.join('\n'))
        }

        const fullText = sections.join('\n')
        if (fullText.length <= maxPromptChars) return fullText
        return fullText.slice(0, maxPromptChars).trimEnd() + '\n[内容因 skills.documents.maxPromptChars 限制截断]'
    }
}

export const skillDocumentLoader = new SkillDocumentLoader()

export default SkillDocumentLoader
