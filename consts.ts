// Gift name to emoji mapping
export const EMOJI_MAP: Record<string, string> = {
  // 礼物
  小花花: '🌺',
  粉丝团灯牌: '💡',
  幸运之钥: '🔑',
  盛典门票: '🎫',
  热气球: '🎈',
  极速超跑: '🏎',
  次元之城: '🏯',
  快乐水: '🥤',
  冲鸭: '🐤',
  草莓蛋糕: '🎂',
  花式夸夸: '😘',
  许愿精灵: '🧚‍♀️',
  星愿水晶球: '🔮',
  明灯相伴: '🏮',
  探索者起航: '🚀🚀',
  牛哇牛哇: '🐮',
  加鸡腿: '🍗',
  星河入梦: '🌌',
  美梦成真: '🌠',
  超感摩托: '🏍',
  我星永恒: '💫',
  为你加冕: '👑',
  星轨列车: '🚅',
  打call: '🤙',
  这个好诶: '👍',
  瓜瓜: '🍉',
  情书: '💌',
  干杯: '🍻',
  告白花束: '💐',
  璀璨烟火: '🎆',
  守护之翼: '👼',
  梦游仙境: '🏞',
  为你摘星: '✨',
  节奏风暴: '⚡️',
  // 特权
  心动卡: '💓',
  泡泡机: '🫧',
  爱之魔力: '🥰',
  摩天轮: '🎡',
  转运锦鲤: '🎏',
  领航者飞船: '🚀',
  友谊的小船: '🛶',
  冲浪: '🌊',
  海湾之旅: '🧜‍♀️',
  鸿运小电视: '📺',
  海底历险记: '🪸',
  // 定制
  么么哒: '💋',
  奈斯: '👍',
  变身话筒: '🎙️',
  打榜: '👊👍',
  喵娘: '🐱',
  柠檬冰淇淋茶: '🍹',
  // 节日限定
  月饼: '🥮',
  星河月: '🌛',
  嫦娥派福: '🧝‍♀️🥧🧧',
}

// Guard type icons
export const GUARD_TYPE_DICT: Record<number, string> = {
  0: '',
  1: '🚢', // 总督
  2: '🛥', // 提督
  3: '🚤', // 舰长
}

// Price tier emoji for gifts (in coins, 1000 coins = 1 CNY)
export function PRICE_TIER_EMOJI(price: number): string {
  if (price >= 2000000) return '🟣'
  if (price >= 1000000) return '🔴'
  if (price >= 500000) return '🟠'
  if (price >= 100000) return '🟡'
  if (price >= 50000) return '🟢'
  if (price >= 30000) return '🔵'
  return ''
}

// SuperChat tier emoji (in CNY)
export function SUPERCHAT_TIER_EMOJI(price: number): string {
  if (price >= 2000) return '🟪'
  if (price >= 1000) return '🟥'
  if (price >= 500) return '🟧'
  if (price >= 100) return '🟨'
  if (price >= 50) return '🟩'
  if (price >= 30) return '🟦'
  return ''
}

// Mute by mapping
export function MUTE_BY_MAP(muteBy: string): string {
  if (muteBy === 'level') return '用户等级'
  if (muteBy === 'wealth') return '荣耀等级'
  if (muteBy === 'medal') return '粉丝勋章'
  if (muteBy === 'member') return '全员'
  return '未知'
}
