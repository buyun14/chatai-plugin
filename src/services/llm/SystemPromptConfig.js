const SYSTEM_PROMPT_MODES = new Set(['inherit', 'replace', 'disable'])
const SYSTEM_PROMPT_TARGETS = new Set(['messages', 'instructions', 'top_level_text', 'top_level_object'])

export const DEFAULT_SYSTEM_PROMPT_CONFIG = Object.freeze({
    mode: 'inherit',
    target: 'messages',
    fieldName: '',
    role: 'auto',
    override: '',
    prefix: '',
    suffix: ''
})

function normalizeString(value) {
    return typeof value === 'string' ? value : ''
}

export function normalizeSystemPromptConfig(systemPromptConfig, overrides = {}) {
    const hasLegacyPrefix = typeof overrides?.systemPromptPrefix === 'string' && overrides.systemPromptPrefix.length > 0
    const hasLegacySuffix = typeof overrides?.systemPromptSuffix === 'string' && overrides.systemPromptSuffix.length > 0
    const hasObjectConfig =
        systemPromptConfig && typeof systemPromptConfig === 'object' && !Array.isArray(systemPromptConfig)

    if (!hasObjectConfig && !hasLegacyPrefix && !hasLegacySuffix) {
        return null
    }

    const normalized = { ...DEFAULT_SYSTEM_PROMPT_CONFIG }

    if (hasObjectConfig) {
        if (SYSTEM_PROMPT_MODES.has(systemPromptConfig.mode)) {
            normalized.mode = systemPromptConfig.mode
        }
        if (SYSTEM_PROMPT_TARGETS.has(systemPromptConfig.target)) {
            normalized.target = systemPromptConfig.target
        }
        normalized.fieldName = normalizeString(systemPromptConfig.fieldName)
        normalized.role = normalizeString(systemPromptConfig.role) || DEFAULT_SYSTEM_PROMPT_CONFIG.role
        normalized.override = normalizeString(systemPromptConfig.override)
        normalized.prefix = normalizeString(systemPromptConfig.prefix)
        normalized.suffix = normalizeString(systemPromptConfig.suffix)
    }

    if (!normalized.prefix && hasLegacyPrefix) {
        normalized.prefix = overrides.systemPromptPrefix
    }
    if (!normalized.suffix && hasLegacySuffix) {
        normalized.suffix = overrides.systemPromptSuffix
    }

    return isSystemPromptConfigCustomized(normalized) ? normalized : null
}

export function isSystemPromptConfigCustomized(systemPromptConfig) {
    if (!systemPromptConfig) return false

    return (
        systemPromptConfig.mode !== DEFAULT_SYSTEM_PROMPT_CONFIG.mode ||
        systemPromptConfig.target !== DEFAULT_SYSTEM_PROMPT_CONFIG.target ||
        systemPromptConfig.fieldName !== DEFAULT_SYSTEM_PROMPT_CONFIG.fieldName ||
        systemPromptConfig.role !== DEFAULT_SYSTEM_PROMPT_CONFIG.role ||
        systemPromptConfig.override !== DEFAULT_SYSTEM_PROMPT_CONFIG.override ||
        systemPromptConfig.prefix !== DEFAULT_SYSTEM_PROMPT_CONFIG.prefix ||
        systemPromptConfig.suffix !== DEFAULT_SYSTEM_PROMPT_CONFIG.suffix
    )
}

export function resolveSystemPromptWithConfig(systemPrompt = '', systemPromptConfig = null, overrides = {}) {
    const normalizedConfig = normalizeSystemPromptConfig(systemPromptConfig, overrides)

    if (!normalizedConfig) {
        return {
            systemPrompt,
            systemPromptConfig: null
        }
    }

    if (normalizedConfig.mode === 'disable') {
        return {
            systemPrompt: '',
            systemPromptConfig: normalizedConfig
        }
    }

    let resolvedPrompt = systemPrompt || ''

    if (normalizedConfig.mode === 'replace') {
        resolvedPrompt = normalizedConfig.override || ''
    }

    if (normalizedConfig.prefix) {
        resolvedPrompt = `${normalizedConfig.prefix}${resolvedPrompt}`
    }
    if (normalizedConfig.suffix) {
        resolvedPrompt = `${resolvedPrompt}${normalizedConfig.suffix}`
    }

    return {
        systemPrompt: resolvedPrompt,
        systemPromptConfig: normalizedConfig
    }
}

export function resolveChannelSystemPrompt(systemPrompt = '', channel = null) {
    return resolveSystemPromptWithConfig(systemPrompt, channel?.systemPromptConfig, channel?.overrides)
}
