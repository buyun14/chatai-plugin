import crypto from 'node:crypto'
import config from '../../../config/config.js'
import { chatLogger as logger } from '../../core/utils/logger.js'
import { toolFilterService } from './ToolFilterService.js'

const RISK_ORDER = { low: 0, medium: 1, high: 2 }
const VALID_MODES = ['ask', 'auto', 'confirm_all', 'yolo']
const SENSITIVE_KEY_RE = /(api[-_]?key|token|password|secret|authorization|cookie|key)/i

const DEFAULT_LOW_RISK_TOOLS = new Set([
    'get_time',
    'get_date',
    'get_system_info',
    'calculate',
    'calculator',
    'web_search',
    'search_web',
    'search',
    'get_bot_info',
    'get_group_info',
    'get_member_info',
    'get_user_info',
    'get_weather'
])

const DEFAULT_MEDIUM_RISK_TOOLS = new Set([
    'send_message',
    'send_group_message',
    'send_private_message',
    'reply_current_message',
    'send_forward_message',
    'poke_user',
    'at_user',
    'save_memory',
    'write_context',
    'read_file',
    'list_directory',
    'fetch_url',
    'read_webpage',
    'download_file',
    'generate_image',
    'send_image',
    'send_ai_voice'
])

const DEFAULT_HIGH_RISK_TOOLS = new Set([
    'kick_member',
    'mute_member',
    'recall_message',
    'mute_all',
    'set_group_admin',
    'set_group_card',
    'set_group_title',
    'set_group_name',
    'send_group_notice',
    'delete_group_notice',
    'write_file',
    'delete_file',
    'move_file',
    'copy_file',
    'create_directory',
    'execute_command'
])

class ToolApprovalService {
    constructor() {
        this.pendingApprovals = new Map()
        this.sessionBypass = new Map()
    }

    getConfig() {
        const builtinTools = config.get('builtinTools') || {}
        return {
            approvalMode: this.normalizeMode(builtinTools.approvalMode),
            approvalTimeoutMs: Number(builtinTools.approvalTimeoutMs) || 60000,
            approvalLowRiskTools: builtinTools.approvalLowRiskTools || [],
            approvalMediumRiskTools: builtinTools.approvalMediumRiskTools || [],
            approvalHighRiskTools: builtinTools.approvalHighRiskTools || [],
            approvalBypassTools: builtinTools.approvalBypassTools || [],
            approvalAllowSessionBypass: builtinTools.approvalAllowSessionBypass !== false,
            approvalSessionBypassMaxRisk: this.normalizeRisk(builtinTools.approvalSessionBypassMaxRisk || 'medium')
        }
    }

    normalizeMode(mode) {
        return VALID_MODES.includes(mode) ? mode : 'auto'
    }

    normalizeRisk(risk) {
        return ['low', 'medium', 'high'].includes(risk) ? risk : 'medium'
    }

    normalizeToolCall(toolCall) {
        const name = toolCall.function?.name || toolCall.name || 'unknown_tool'
        let args = toolCall.function?.arguments ?? toolCall.arguments ?? {}
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args)
            } catch {
                args = {}
            }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
        return { id: toolCall.id || crypto.randomUUID(), name, args, raw: toolCall }
    }

    classifyRisk(toolName, tool = null) {
        const cfg = this.getConfig()
        if (cfg.approvalHighRiskTools.includes(toolName)) return 'high'
        if (cfg.approvalMediumRiskTools.includes(toolName)) return 'medium'
        if (cfg.approvalLowRiskTools.includes(toolName)) return 'low'

        const dangerousTools = config.get('builtinTools.dangerousTools') || []
        if (
            tool?.dangerous ||
            tool?.function?.dangerous ||
            dangerousTools.includes(toolName) ||
            DEFAULT_HIGH_RISK_TOOLS.has(toolName)
        ) {
            return 'high'
        }
        if (
            DEFAULT_MEDIUM_RISK_TOOLS.has(toolName) ||
            /(^send_|_message$|file|url|webpage|download|memory|context|image|voice|media)/i.test(toolName)
        ) {
            return 'medium'
        }
        if (
            DEFAULT_LOW_RISK_TOOLS.has(toolName) ||
            /^(get|list|search|query|read_context|calculate|calc)_?/i.test(toolName)
        ) {
            return 'low'
        }
        return 'medium'
    }

    createToolResult(toolCall, name, message, isError = true) {
        const content = JSON.stringify({
            status: isError ? 'error' : 'success',
            tool: name,
            content: message,
            metadata: { approval: true }
        })
        return {
            toolResult: {
                tool_call_id: toolCall.id || crypto.randomUUID(),
                content,
                type: 'tool',
                name
            },
            log: {
                name,
                args: {},
                result: message,
                duration: 0,
                isError
            }
        }
    }

    getScopeKey(options = {}) {
        const conversationId = options.conversationId || 'default'
        const userId = options.userId || options.event?.user_id || 'unknown'
        const groupId = options.groupId || options.event?.group_id || 'private'
        return `${conversationId}:${groupId}:${userId}`
    }

    getBypassKey(options, toolName) {
        return `${this.getScopeKey(options)}:${toolName}`
    }

    canSessionBypass(risk, cfg = this.getConfig()) {
        return cfg.approvalAllowSessionBypass && RISK_ORDER[risk] <= RISK_ORDER[cfg.approvalSessionBypassMaxRisk]
    }

    isSessionBypassed(options, toolName, risk) {
        if (!this.canSessionBypass(risk)) return false
        return this.sessionBypass.has(this.getBypassKey(options, toolName))
    }

    addSessionBypass(options, items) {
        for (const item of items) {
            if (this.canSessionBypass(item.risk)) {
                this.sessionBypass.set(this.getBypassKey(options, item.name), Date.now())
            }
        }
    }

    redactValue(key, value, depth = 0) {
        if (SENSITIVE_KEY_RE.test(String(key))) return '***'
        if (value == null) return value
        if (typeof value === 'string') {
            return value.length > 160 ? `${value.slice(0, 160)}...` : value
        }
        if (typeof value !== 'object') return value
        if (depth >= 2) return '[Object]'
        if (Array.isArray(value)) {
            return value.slice(0, 10).map((item, index) => this.redactValue(index, item, depth + 1))
        }
        const result = {}
        for (const [childKey, childValue] of Object.entries(value).slice(0, 20)) {
            result[childKey] = this.redactValue(childKey, childValue, depth + 1)
        }
        return result
    }

    summarizeArgs(args) {
        const redacted = this.redactValue('', args)
        const text = JSON.stringify(redacted)
        return text.length > 500 ? `${text.slice(0, 500)}...` : text
    }

    buildApprovalMessage(items, cfg = this.getConfig()) {
        const lines = ['检测到模型请求执行工具：']
        items.forEach((item, index) => {
            lines.push(`[${index + 1}] ${item.name} 风险: ${item.risk}`)
            lines.push(`参数: ${item.summary}`)
        })
        lines.push('')
        lines.push(cfg.approvalAllowSessionBypass ? '回复：确认 / 取消 / 允许本对话' : '回复：确认 / 取消')
        return lines.join('\n')
    }

    async sendApprovalPrompt(options, message) {
        const event = options.event
        if (!event?.reply) {
            logger.warn('[ToolApproval] 无可用 event.reply，拒绝需要确认的工具调用')
            return false
        }
        await event.reply(message, true)
        return true
    }

    createApproval(items, options, cfg) {
        const approvalId = crypto.randomBytes(4).toString('hex')
        const key = this.getScopeKey(options)
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pendingApprovals.delete(approvalId)
                resolve({ action: 'timeout', approvalId })
            }, cfg.approvalTimeoutMs)
            this.pendingApprovals.set(approvalId, {
                approvalId,
                key,
                items,
                options,
                timer,
                resolve,
                createdAt: Date.now()
            })
        })
    }

    async preflight(toolCalls, options = {}) {
        const cfg = this.getConfig()
        const mode = this.normalizeMode(options.toolApprovalMode || cfg.approvalMode)
        const passThrough = []
        const blockedResults = []
        const needsApproval = []
        const presetId = options.presetId || 'default'
        const userPermission = options.userPermission || options.event?.sender?.role || 'member'
        const context = {
            groupId: options.groupId || options.event?.group_id,
            userId: options.userId || options.event?.user_id
        }

        const availableToolNames = new Set(
            (options.availableTools || []).map(t => t.function?.name || t.name).filter(Boolean)
        )

        for (const toolCall of toolCalls || []) {
            const normalized = this.normalizeToolCall(toolCall)
            if (
                normalized.name === 'unknown_tool' ||
                (availableToolNames.size > 0 && !availableToolNames.has(normalized.name))
            ) {
                const reason =
                    normalized.name === 'unknown_tool'
                        ? '工具未执行：工具名称缺失'
                        : `工具未执行：未知工具 ${normalized.name}`
                blockedResults.push(this.createToolResult(toolCall, normalized.name, reason))
                continue
            }

            const access = toolFilterService.checkToolAccess(normalized.name, presetId, {
                userPermission,
                groupId: context.groupId,
                userId: context.userId
            })
            if (!access.allowed) {
                blockedResults.push(this.createToolResult(toolCall, normalized.name, `工具未执行：${access.reason}`))
                continue
            }

            const validation = toolFilterService.validateToolCall(normalized.name, normalized.args, context)
            if (!validation.valid) {
                blockedResults.push(
                    this.createToolResult(toolCall, normalized.name, `工具未执行：${validation.reason}`)
                )
                continue
            }

            const tool = options.availableTools?.find?.(
                t => t.function?.name === normalized.name || t.name === normalized.name
            )
            const risk = this.classifyRisk(normalized.name, tool)
            normalized.risk = risk
            normalized.summary = this.summarizeArgs(normalized.args)

            if (mode === 'ask') {
                blockedResults.push(this.createToolResult(toolCall, normalized.name, 'ask 模式不执行工具'))
                continue
            }
            if (mode === 'yolo' || cfg.approvalBypassTools.includes(normalized.name)) {
                passThrough.push(toolCall)
                continue
            }
            if (this.isSessionBypassed(options, normalized.name, risk)) {
                passThrough.push(toolCall)
                continue
            }
            if (mode === 'auto' && risk === 'low') {
                passThrough.push(toolCall)
                continue
            }

            needsApproval.push(normalized)
        }

        if (needsApproval.length === 0) {
            return { approvedToolCalls: passThrough, blockedResults }
        }

        const message = this.buildApprovalMessage(needsApproval, cfg)
        const sent = await this.sendApprovalPrompt(options, message)
        if (!sent) {
            for (const item of needsApproval) {
                blockedResults.push(this.createToolResult(item.raw, item.name, '工具未执行：当前环境无法发送确认请求'))
            }
            return { approvedToolCalls: passThrough, blockedResults }
        }

        const result = await this.createApproval(needsApproval, options, cfg)
        if (result.action === 'confirm' || result.action === 'allow_session') {
            if (result.action === 'allow_session') this.addSessionBypass(options, needsApproval)
            passThrough.push(...needsApproval.map(item => item.raw))
        } else {
            const reason = result.action === 'timeout' ? '确认超时' : '用户取消'
            for (const item of needsApproval) {
                blockedResults.push(this.createToolResult(item.raw, item.name, `工具未执行：${reason}`))
            }
        }

        return { approvedToolCalls: passThrough, blockedResults }
    }

    resolveApproval(input, options = {}) {
        const text = String(input || '').trim()
        if (!text) return { matched: false }

        let action = null
        let explicitId = null
        const idMatch = text.match(/(?:确认工具|取消工具)\s*([a-f0-9]{8})/i)
        if (/^(确认|确认工具)/.test(text)) action = 'confirm'
        if (/^(取消|取消工具|拒绝)/.test(text)) action = 'cancel'
        if (/^(允许本对话|总是允许本对话)/.test(text)) action = 'allow_session'
        if (idMatch) explicitId = idMatch[1]
        if (!action) return { matched: false }

        const key = this.getScopeKey(options)
        const candidates = [...this.pendingApprovals.values()].filter(item => item.key === key)
        const approval = explicitId
            ? candidates.find(item => item.approvalId === explicitId)
            : candidates.sort((a, b) => b.createdAt - a.createdAt)[0]

        if (!approval) return { matched: false }

        clearTimeout(approval.timer)
        this.pendingApprovals.delete(approval.approvalId)
        approval.resolve({ action, approvalId: approval.approvalId })
        return { matched: true, handled: true, action, approvalId: approval.approvalId }
    }
}

export const toolApprovalService = new ToolApprovalService()
export default toolApprovalService
