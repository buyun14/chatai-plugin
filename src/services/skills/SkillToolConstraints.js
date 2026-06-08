import { getToolDefinitionName, getToolIdentity } from '../../core/adapters/tooling.js'

function toList(value) {
    return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : []
}

function toolMatches(list, tool) {
    if (!Array.isArray(list) || list.length === 0) return false
    const values = new Set(list)
    const name = getToolDefinitionName(tool)
    const identity = getToolIdentity(tool)
    return Boolean((name && values.has(name)) || (identity && values.has(identity)))
}

export function getSkillToolConstraints(options = {}) {
    const documents = global.chatAiSkillsLoader?.getMatchingSkillDocuments?.(options) || []
    const allowedTools = []
    const disallowedTools = []

    for (const document of documents) {
        allowedTools.push(...toList(document.allowedTools))
        disallowedTools.push(...toList(document.disallowedTools))
    }

    return {
        documents,
        allowedTools: Array.from(new Set(allowedTools)),
        disallowedTools: Array.from(new Set(disallowedTools))
    }
}

export function applySkillToolConstraints(tools, constraints = {}) {
    if (!Array.isArray(tools) || tools.length === 0) return tools || []
    let filteredTools = tools
    const allowedTools = toList(constraints.allowedTools)
    const disallowedTools = toList(constraints.disallowedTools)

    if (allowedTools.length > 0) {
        filteredTools = filteredTools.filter(tool => toolMatches(allowedTools, tool))
    }
    if (disallowedTools.length > 0) {
        filteredTools = filteredTools.filter(tool => !toolMatches(disallowedTools, tool))
    }
    return filteredTools
}
