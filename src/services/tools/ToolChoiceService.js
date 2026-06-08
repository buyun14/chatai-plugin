import { normalizeToolChoice } from '../../core/adapters/tooling.js'

function readToolChoice(value) {
    return normalizeToolChoice(value)
}

function readToolChoiceFromObject(value) {
    if (!value || typeof value !== 'object') return null
    return readToolChoice(value.toolChoice) || readToolChoice(value.tool_choice)
}

/**
 * 解析模型侧工具选择配置。
 *
 * toolApprovalMode 控制执行前审批；toolChoice 控制模型端是否、如何选择工具。
 * @param {Object} options
 * @param {Object} [options.requestOptions]
 * @param {Object} [options.preset]
 * @param {Object} [options.channel]
 * @returns {Object|null}
 */
export function resolveConfiguredToolChoice({ requestOptions = {}, preset = null, channel = null } = {}) {
    return (
        readToolChoiceFromObject(requestOptions) ||
        readToolChoiceFromObject(preset?.tools) ||
        readToolChoiceFromObject(preset) ||
        readToolChoiceFromObject(channel?.advanced?.tools) ||
        readToolChoiceFromObject(channel?.tools) ||
        null
    )
}

export function normalizeAdvancedToolsConfig(tools = {}) {
    const source = tools && typeof tools === 'object' && !Array.isArray(tools) ? tools : {}
    const toolChoice = readToolChoiceFromObject(source)
    return {
        ...(source.toolChoice !== undefined || source.tool_choice !== undefined
            ? {
                  toolChoice: toolChoice || { type: 'auto' }
              }
            : {})
    }
}
