import config from '../../../config/config.js'

function positiveTokenBudget(...values) {
    for (const value of values) {
        const numericValue = Number(value)
        if (Number.isFinite(numericValue) && numericValue > 0) return Math.floor(numericValue)
    }
    return undefined
}

/**
 * Resolve reasoning options with the same precedence across chat entry points.
 * Request options take precedence, then preset, channel, and finally global config.
 */
export function resolveThinkingOptions({ requestOptions = {}, preset = null, channel = null } = {}) {
    const globalThinking = config.get('thinking') || {}
    const channelThinking = channel?.advanced?.thinking || {}
    const enabledByGlobal = globalThinking.enabled !== false
    const explicitEnable =
        requestOptions.enableReasoning ??
        requestOptions.thinking?.enableReasoning ??
        preset?.enableReasoning ??
        channelThinking.enableReasoning ??
        globalThinking.enableReasoning ??
        false

    return {
        enableReasoning: enabledByGlobal ? explicitEnable === true : false,
        reasoningEffort:
            requestOptions.reasoningEffort ??
            requestOptions.thinking?.defaultLevel ??
            preset?.reasoningEffort ??
            preset?.defaultLevel ??
            channelThinking.defaultLevel ??
            globalThinking.defaultLevel ??
            'low',
        thinkingVendorControl:
            requestOptions.thinkingVendorControl ??
            requestOptions.thinking?.vendorThinkingControl ??
            channelThinking.vendorThinkingControl ??
            globalThinking.vendorThinkingControl ??
            'auto',
        reasoningBudgetTokens: positiveTokenBudget(
            requestOptions.reasoningBudgetTokens ?? requestOptions.thinking?.reasoningBudgetTokens,
            preset?.reasoningBudgetTokens,
            channelThinking.reasoningBudgetTokens,
            globalThinking.reasoningBudgetTokens
        )
    }
}
