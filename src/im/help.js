'use strict';
// 机器人文案：首次使用欢迎消息 + /bot help 完整帮助（纯文本，适配器按 QQ 限长自动分段）

const WELCOME_TEXT = [
  '👋 已连接 DSH Desk 远程机器人',
  '我是电脑上 DeepSeek Harness 的入口，用 QQ 就能远程对话和查状态。',
  '',
  '快速开始：',
  '1. /ws 选择工作区（官方机器人可直接点下方按钮）',
  '2. /ses 选择会话（只列当前工作区的；可直接点按钮）',
  '3. 绑定后直接发消息即可对话（忙时自动排队）',
  '',
  '发 /help 查看完整说明。',
].join('\n');

// 收到但无法处理的消息（图片/语音/表情等非文本）
const UNPROCESSABLE_TEXT = '🔇 暂时只支持文字消息（图片/语音/表情等暂不支持），请用文字提问。';

const HELP_TEXT = [
  'DSH 远程机器人指令',
  '━━━━━━━━━━━━━━━',
  '',
  '/ws          工作区：列 / 选',
  '/ses         会话：列 / 选（只列当前工作区的）',
  '/status      机器人连接与绑定状态',
  '/usage       余额 + 会话费用 + 本次消费（含 Token 明细）',
  '/setting     查看/修改设置（闲置自动退出等）',
  '/help        本帮助',
  '',
  '【更多命令】',
  '/model       切换模型（provider/model）',
  '/history n   最近 n 条聊天记录',
  '/stop        打断当前生成',
  '/queue       查看排队状态',
  '',
  '【说明】',
  '· 官方机器人列表带可点击按钮，点一下即可选择',
  '· 发普通文本 = 对话；忙时自动排队，完成后通知你',
  '· 以 / 开头的其他命令（如 /plan、/goal）原样透传由 dsh 执行',
  '· 白名单与口令：DSH Desk 托盘 → 机器人 → 配置',
].join('\n');

module.exports = { WELCOME_TEXT, UNPROCESSABLE_TEXT, HELP_TEXT };
