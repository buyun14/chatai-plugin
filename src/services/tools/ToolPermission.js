import { isMaster as isMasterUser } from '../../utils/platformAdapter.js'

const PERMISSION_LEVELS = {
    member: 0,
    admin: 1,
    owner: 2,
    master: 3
}

export function resolveToolPermission(options = {}) {
    if (options.isMaster || options.event?.isMaster) return 'master'

    const userId = options.userId || options.event?.user_id
    if (userId && isMasterUser(userId)) return 'master'

    const permission = options.userPermission || options.senderRole || options.event?.sender?.role || 'member'
    return typeof permission === 'string' && permission.trim() ? permission.trim() : 'member'
}

export function hasToolPermission(userPermission, requiredPermission) {
    if (!requiredPermission) return true
    const userLevel = PERMISSION_LEVELS[userPermission] ?? PERMISSION_LEVELS.member
    const requiredLevel = PERMISSION_LEVELS[requiredPermission]
    if (requiredLevel === undefined) return false
    return userLevel >= requiredLevel
}
