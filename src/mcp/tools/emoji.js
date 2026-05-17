/**
 * 表情包管理工具
 * AI偷取/保存表情、AI匹配场景发送表情、人工偷图响应
 */
import fsp from 'fs/promises'
import path from 'path'
import { chatLogger as logger } from '../../core/utils/logger.js'
import { emojiThiefService } from '../../../apps/EmojiThief.js'
import { segment } from '../../utils/messageParser.js'

async function listEmojiFiles(groupId) {
    await emojiThiefService.init()
    const config = await emojiThiefService.getGroupConfig(groupId)
    const emojiDir = emojiThiefService.getEmojiDir(groupId, config.separateFolder)
    try {
        const files = await fsp.readdir(emojiDir)
        return files
            .filter(f => /\.(gif|png|jpg|jpeg|webp)$/i.test(f))
            .map(f => ({
                name: f,
                path: path.join(emojiDir, f)
            }))
    } catch {
        return []
    }
}

async function saveImageAsEmoji(groupId, imageUrl) {
    await emojiThiefService.init()
    const config = await emojiThiefService.getGroupConfig(groupId)
    const emojiDir = emojiThiefService.getEmojiDir(groupId, config.separateFolder ?? true)
    await fsp.mkdir(emojiDir, { recursive: true }).catch(() => {})

    const dbPath = path.join(emojiDir, 'md5.json')
    const md5Db = await emojiThiefService.readMd5Db(dbPath)

    const { default: axios } = await import('axios')
    const resp = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { Referer: 'https://qq.com', 'User-Agent': 'Mozilla/5.0' }
    })
    const buffer = Buffer.from(resp.data)
    const { default: crypto } = await import('crypto')
    const md5 = crypto.createHash('md5').update(buffer).digest('hex')

    if (md5Db.has(md5)) return { success: false, reason: 'duplicate' }

    const files = await fsp.readdir(emojiDir).catch(() => [])
    const emojiCount = files.filter(f => /\.(gif|png|jpg|jpeg|webp)$/i.test(f)).length
    if (emojiCount >= (config.maxCount || 500)) {
        return { success: false, reason: 'max_reached', count: emojiCount }
    }

    let ext = 'png'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) ext = 'gif'
    else if (buffer[0] === 0xff && buffer[1] === 0xd8) ext = 'jpg'
    else if (buffer[0] === 0x52 && buffer[1] === 0x49) ext = 'webp'

    const fileName = `${md5}.${ext}`
    await fsp.writeFile(path.join(emojiDir, fileName), buffer)
    md5Db.add(md5)
    await emojiThiefService.writeMd5Db(dbPath, md5Db)

    return { success: true, fileName, size: buffer.length }
}

export const emojiTools = [
    {
        name: 'save_emoji',
        description:
            '保存一张图片到群表情包库。当用户说"偷图"、"保存这个表情"、"存一下"等，或者你觉得某张图片适合当表情包时使用。需要提供图片URL。',
        category: 'emoji',
        parameters: {
            type: 'object',
            properties: {
                image_url: { type: 'string', description: '要保存的图片URL' },
                reason: { type: 'string', description: '保存原因（可选，如"用户要求保存"或"适合当表情包"）' }
            },
            required: ['image_url']
        },
        handler: async (args, context) => {
            const groupId = context?.event?.group_id
            if (!groupId) return { success: false, error: '仅群聊可用' }

            try {
                const result = await saveImageAsEmoji(String(groupId), args.image_url)
                if (result.success) {
                    logger.info(`[EmojiTool] 群${groupId}保存表情成功: ${result.fileName}`)
                    return { success: true, message: `表情已保存 (${result.fileName})`, fileName: result.fileName }
                }
                if (result.reason === 'duplicate') return { success: false, message: '这张图已经存过了' }
                if (result.reason === 'max_reached') return { success: false, message: `表情包已满(${result.count}张)` }
                return { success: false, message: '保存失败' }
            } catch (err) {
                logger.warn('[EmojiTool] 保存表情失败:', err.message)
                return { success: false, error: err.message }
            }
        }
    },
    {
        name: 'send_saved_emoji',
        description:
            '从群表情包库中选择并发送一个表情包。当场景适合发表情包、用户要求发表情、或者用户说"发个表情""之前那个图呢"时使用。可以指定描述来匹配，也可以随机发送。',
        category: 'emoji',
        parameters: {
            type: 'object',
            properties: {
                random: { type: 'boolean', description: '是否随机选择（默认true）' },
                index: { type: 'number', description: '指定发送第几张（从0开始，需要先用list_saved_emojis查看）' }
            }
        },
        handler: async (args, context) => {
            const groupId = context?.event?.group_id
            const e = context?.event
            if (!groupId) return { success: false, error: '仅群聊可用' }

            try {
                const files = await listEmojiFiles(String(groupId))
                if (files.length === 0) return { success: false, message: '群表情包库为空' }

                let selected
                if (args.index !== undefined && args.index >= 0 && args.index < files.length) {
                    selected = files[args.index]
                } else {
                    selected = files[Math.floor(Math.random() * files.length)]
                }

                const emojiMsg = emojiThiefService.buildEmojiMessage(selected.path)
                if (e?.reply) {
                    await e.reply(emojiMsg)
                    return { success: true, message: `已发送表情 ${selected.name}`, sent: true }
                }
                if (e?.bot) {
                    const group = e.bot.pickGroup?.(groupId) || e.bot
                    if (group.sendMsg) {
                        await group.sendMsg([emojiMsg])
                        return { success: true, message: `已发送表情 ${selected.name}`, sent: true }
                    }
                }
                return { success: true, message: `表情文件: ${selected.name}`, filePath: selected.path, sent: false }
            } catch (err) {
                return { success: false, error: err.message }
            }
        }
    },
    {
        name: 'list_saved_emojis',
        description: '列出群表情包库中已保存的表情。当用户问"有什么表情""表情包列表"时使用。',
        category: 'emoji',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: '最多返回数量（默认20）' }
            }
        },
        handler: async (args, context) => {
            const groupId = context?.event?.group_id
            if (!groupId) return { success: false, error: '仅群聊可用' }

            try {
                const files = await listEmojiFiles(String(groupId))
                const limit = Math.min(args.limit || 20, 50)
                const stats = await emojiThiefService.getGroupStats(String(groupId))
                return {
                    success: true,
                    total: files.length,
                    maxCount: stats.maxCount,
                    enabled: stats.enabled,
                    triggerMode: stats.triggerMode,
                    emojis: files.slice(0, limit).map((f, i) => ({
                        index: i,
                        name: f.name,
                        type: path.extname(f.name).slice(1)
                    }))
                }
            } catch (err) {
                return { success: false, error: err.message }
            }
        }
    }
]
