import { chatLogger } from '../../core/utils/logger.js'

const logger = chatLogger
const PRICING_API_URL = 'https://models.dev/api.json'
const CACHE_TTL = 24 * 60 * 60 * 1000

class ModelPricingService {
    constructor() {
        this.pricingData = null
        this.modelIndex = null
        this.lastFetch = 0
        this.fetching = null
    }

    async fetchPricing() {
        if (this.pricingData && Date.now() - this.lastFetch < CACHE_TTL) {
            return this.pricingData
        }
        if (this.fetching) return this.fetching

        this.fetching = this._doFetch()
        try {
            return await this.fetching
        } finally {
            this.fetching = null
        }
    }

    async _doFetch() {
        try {
            const response = await fetch(PRICING_API_URL, {
                signal: AbortSignal.timeout(15000),
                headers: { Accept: 'application/json' }
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            this.pricingData = data
            this.lastFetch = Date.now()
            this._buildIndex(data)
            logger.info(`[ModelPricing] 价格数据已更新，${Object.keys(this.modelIndex).length} 个模型`)
            return data
        } catch (error) {
            logger.warn('[ModelPricing] 获取价格数据失败:', error.message)
            if (this.pricingData) return this.pricingData
            return null
        }
    }

    _buildIndex(data) {
        const index = {}
        if (!data || typeof data !== 'object') return

        for (const [providerId, provider] of Object.entries(data)) {
            if (!provider?.models) continue
            for (const [modelId, model] of Object.entries(provider.models)) {
                if (!model?.cost) continue
                const entry = {
                    id: modelId,
                    name: model.name || modelId,
                    provider: provider.name || providerId,
                    providerId,
                    cost: {
                        input: model.cost.input || 0,
                        output: model.cost.output || 0,
                        cacheRead: model.cost.cache_read || 0,
                        cacheWrite: model.cost.cache_write || 0
                    }
                }
                index[modelId] = entry
                const shortId = modelId.split('/').pop()
                if (shortId !== modelId && !index[shortId]) {
                    index[shortId] = entry
                }
            }
        }
        this.modelIndex = index
    }

    _findModel(modelId) {
        if (!this.modelIndex) return null
        if (this.modelIndex[modelId]) return this.modelIndex[modelId]

        const shortId = modelId.split('/').pop()
        if (this.modelIndex[shortId]) return this.modelIndex[shortId]

        const normalized = modelId.toLowerCase().replace(/[^a-z0-9.-]/g, '')
        for (const [key, value] of Object.entries(this.modelIndex)) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z0-9.-]/g, '')
            if (normalizedKey === normalized) return value
        }

        for (const [key, value] of Object.entries(this.modelIndex)) {
            if (key.includes(shortId) || shortId.includes(key)) return value
        }

        return null
    }

    calculateCost(modelId, inputTokens, outputTokens) {
        const model = this._findModel(modelId)
        if (!model) return null

        const inputCost = (inputTokens / 1_000_000) * model.cost.input
        const outputCost = (outputTokens / 1_000_000) * model.cost.output
        return {
            modelId: model.id,
            modelName: model.name,
            provider: model.provider,
            inputCost,
            outputCost,
            totalCost: inputCost + outputCost,
            pricePerMInput: model.cost.input,
            pricePerMOutput: model.cost.output
        }
    }

    async calculateStatsOverviewCost(statsOverview) {
        await this.fetchPricing()
        if (!this.modelIndex) return null

        let totalCost = 0
        const modelCosts = []

        const modelStats = statsOverview?.models?.byModel || []
        for (const model of modelStats) {
            const cost = this.calculateCost(model.name, model.inputTokens, model.outputTokens)
            if (cost) {
                totalCost += cost.totalCost
                modelCosts.push({
                    model: model.name,
                    displayName: cost.modelName,
                    provider: cost.provider,
                    calls: model.calls,
                    inputTokens: model.inputTokens,
                    outputTokens: model.outputTokens,
                    inputCost: cost.inputCost,
                    outputCost: cost.outputCost,
                    totalCost: cost.totalCost,
                    pricePerMInput: cost.pricePerMInput,
                    pricePerMOutput: cost.pricePerMOutput
                })
            } else {
                modelCosts.push({
                    model: model.name,
                    displayName: model.name,
                    provider: null,
                    calls: model.calls,
                    inputTokens: model.inputTokens,
                    outputTokens: model.outputTokens,
                    inputCost: null,
                    outputCost: null,
                    totalCost: null,
                    pricePerMInput: null,
                    pricePerMOutput: null
                })
            }
        }

        modelCosts.sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0))

        const userCosts = []
        const userTokens = statsOverview?.tokens?.topUsers || []
        for (const user of userTokens) {
            let userCost = 0
            let hasPrice = false
            for (const mc of modelCosts) {
                if (mc.totalCost !== null && mc.calls > 0) {
                    hasPrice = true
                    const ratio = user.total / (statsOverview?.tokens?.totalSum || 1)
                    userCost += mc.totalCost * ratio
                }
            }
            userCosts.push({
                userId: user.userId,
                inputTokens: user.input,
                outputTokens: user.output,
                totalTokens: user.total,
                estimatedCost: hasPrice ? userCost : null
            })
        }

        return {
            totalCost,
            modelCosts,
            userCosts,
            matched: modelCosts.filter(m => m.totalCost !== null).length,
            unmatched: modelCosts.filter(m => m.totalCost === null).length,
            lastPricingUpdate: this.lastFetch
        }
    }

    async getPricingInfo() {
        await this.fetchPricing()
        if (!this.modelIndex) return null

        const models = {}
        for (const [id, model] of Object.entries(this.modelIndex)) {
            if (id === model.id) {
                models[id] = {
                    name: model.name,
                    provider: model.provider,
                    input: model.cost.input,
                    output: model.cost.output
                }
            }
        }
        return {
            models,
            lastUpdate: this.lastFetch,
            totalModels: Object.keys(models).length
        }
    }
}

export const modelPricingService = new ModelPricingService()
