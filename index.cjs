require('dotenv').config();
const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes, ChannelType, PermissionsBitField
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

//////////////////// 設定區 ////////////////////
const CREATOR_ID = '1424308660900724858'; // 只有這個人能使用 /炸指令
const ROLE_NAME = '已驗證會員';               // 驗證後給的身分組
const TICKET_CATEGORY_NAME = '提醒區 / 其他';  // 驗證票分類
const CODE_EXPIRE_MINUTES = parseInt(process.env.CODE_EXPIRE_MINUTES || '10', 10);
const COOLDOWN_MS = 100;
////////////////////////////////////////////////

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: ['CHANNEL']
});

// 建立資料庫
const dbFile = path.join(__dirname, 'verify.db');
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    email_hash TEXT,
    code_hash TEXT,
    code_expires_at INTEGER,
    verified INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
});

// 郵件發送設定
let smtpHost, smtpPort = 587;
switch ((process.env.SMTP_PROVIDER || '').toLowerCase()) {
  case 'gmail': smtpHost = 'smtp.gmail.com'; smtpPort = 587; break;
  case 'outlook': smtpHost = 'smtp.office365.com'; smtpPort = 587; break;
  case 'yahoo': smtpHost = 'smtp.mail.yahoo.com'; smtpPort = 587; break;
  case 'custom':
    smtpHost = process.env.SMTP_HOST;
    smtpPort = parseInt(process.env.SMTP_PORT || '587');
    break;
  default: smtpHost = 'smtp.gmail.com'; smtpPort = 587;
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

function sha256(text) { return crypto.createHash('sha256').update(String(text).toLowerCase()).digest('hex'); }
function genCode() { return crypto.randomInt(0, 1000000).toString().padStart(6, '0'); }
function nowEpoch() { return Math.floor(Date.now() / 1000); }
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function splitMessage(text, maxLength = 1900) {
  const parts = []; let current = '';
  for (const line of text.split('\n')) {
    if ((current + line + '\n').length > maxLength) { parts.push(current); current = ''; }
    current += line + '\n';
  }
  if (current.length) parts.push(current);
  return parts;
}

//////////////////// 炸訊息內容 ////////////////////
const spamMessages = {
  炸1: `# 炸\n`.repeat(30),
  炸2: `# 想體驗免費的炸訊息機器人嗎？\n# 加入我們伺服器！\nhttps://discord.gg/QQWERNrPCG`,
  炸3: `@everyone 
# 笑死一群廢物你們被Moonlight給炸了 垃圾們慢慢欣賞炸群吧 🤡 
# LOL, you losers, you guys has been nuked by Moonlight enjoy!! trash 🤡 
# Ɣɛn ë thou në dhöl, yïn kɔc cï määr, yïn acï Moonlit thɔ̈ɔ̈r. Tääu ë pïïr ë pɛ̈c, kɔc cï määr. 🤡 
# Aku hampir mati ketawa, pecundang, kalian sudah diledakkan oleh Moonlight. Nikmati saja ledakannya, pecundang. 🤡
# 笑いすぎて死にそうだ、この負け犬どもめ。ムーンリットに爆破されたんだからな。爆発を楽しめ、負け犬どもめ 🤡
# Me muero de risa, perdedores, Moonlight los ha volado por los aires. Disfruten la explosión, perdedores. 🤡
# https://discord.gg/QQWERNrPCG`,
  炸4: `# 你想要免費機器人嗎？\n# 來吧！\n# 來這個服務器吧！\n# https://discord.gg/QQWERNrPCG`
};

//////////////////// Slash 指令註冊 ////////////////////
const commands = [
  new SlashCommandBuilder().setName('驗證').setDescription('發送公共驗證按鈕（僅管理員可用）').toJSON(),
  ...Object.keys(spamMessages).map(k => new SlashCommandBuilder().setName(k).setDescription(`發送 ${k} 訊息`).toJSON())
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('✅ 指令已註冊完成');
  } catch (e) { console.error('❌ 註冊指令失敗:', e); }
})();

//////////////////// 驗證系統 ////////////////////
const cooldowns = new Map();

async function getOrCreateCategory(guild) {
  let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === TICKET_CATEGORY_NAME);
  if (cat) return cat;
  try {
    cat = await guild.channels.create({ name: TICKET_CATEGORY_NAME, type: ChannelType.GuildCategory });
    return cat;
  } catch (e) {
    console.error('創建分類失敗:', e);
    return null;
  }
}

async function sendVerificationEmail(to, code) {
  const mail = {
    from: process.env.FROM_EMAIL,
    to,
    subject: '您的 Discord 驗證碼',
    text: `您的驗證碼是：${code}\n此驗證碼將在 ${CODE_EXPIRE_MINUTES} 分鐘後失效。`
  };
  await transporter.sendMail(mail);
}

//////////////////// 互動 ////////////////////
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // 管理員使用的 /驗證
      if (cmd === '驗證') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
          return interaction.reply({ content: '❌ 你沒有權限使用此指令', ephemeral: true });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('verify-start').setLabel('📩 開始驗證').setStyle(ButtonStyle.Success)
        );
        await interaction.channel.send({
          content: '請點擊下方「📩 開始驗證」按鈕來進行驗證程序（會自動建立驗證區）',
          components: [row]
        });
        return interaction.reply({ content: '✅ 驗證按鈕已發送', ephemeral: true });
      }

      // 炸訊息指令
      if (Object.keys(spamMessages).includes(cmd)) {
        if (interaction.user.id !== CREATOR_ID)
          return interaction.reply({ content: '❌ 你沒有權限使用這個指令', ephemeral: true });

        const key = `${interaction.user.id}-${cmd}`;
        const now = Date.now();
        if (cooldowns.has(key) && now < cooldowns.get(key))
          return interaction.reply({ content: '🕒 請稍等再使用', ephemeral: true });
        cooldowns.set(key, now + COOLDOWN_MS);

        await interaction.reply({ content: '🚀 正在發送炸訊息...', ephemeral: true });
        const parts = splitMessage(spamMessages[cmd]);
        for (let i = 0; i < 5; i++) {
          for (const p of parts) await interaction.channel.send(p);
          await sleep(500);
        }
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === 'verify-start') {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ 請在伺服器內使用此按鈕', ephemeral: true });

      const cat = await getOrCreateCategory(guild);
      if (!cat) return interaction.reply({ content: '❌ 無法創建驗證區分類', ephemeral: true });

      let base = `驗證-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 80);
      let name = base; let i = 1;
      while (guild.channels.cache.some(c => c.name === name)) { name = `${base}-${i++}`; }

      const ticket = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: cat.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
          { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'] }
        ],
        topic: `驗證頻道 - ${interaction.user.id}`
      });

      await ticket.send(`${interaction.user} 👋 請私訊我並輸入：\`!email 你的電子郵件\` 以開始驗證。`);
      return interaction.reply({ content: `✅ 已建立驗證頻道：${ticket}`, ephemeral: true });
    }

  } catch (e) { console.error(e); }
});

//////////////////// 私訊驗證 ////////////////////
client.on(Events.MessageCreate, async message => {
  if (message.channel.type !== 'DM' || message.author.bot) return;

  if (message.content.startsWith('!email ')) {
    const email = message.content.replace('!email ', '').trim();
    if (!email.includes('@')) return message.reply('❌ 電子郵件格式錯誤，請重新輸入。');

    const code = genCode();
    const userId = message.author.id;
    const guilds = client.guilds.cache.filter(g => g.members.cache.has(userId));
    const guild = guilds.first();
    if (!guild) return message.reply('❌ 找不到您所在的伺服器，請確認您已加入伺服器。');

    db.run(`INSERT INTO pending (user_id, guild_id, email_hash, code_hash, code_expires_at)
            VALUES (?, ?, ?, ?, ?)`,
      [userId, guild.id, sha256(email), sha256(code), nowEpoch() + CODE_EXPIRE_MINUTES * 60],
      async function (err) {
        if (err) return message.reply('❌ 資料庫錯誤，請稍後再試。');
        try {
          await sendVerificationEmail(email, code);
          message.reply(`📧 驗證碼已寄送至 ${email}\n請於 ${CODE_EXPIRE_MINUTES} 分鐘內輸入：\`!code 驗證碼\`。`);
        } catch (e) {
          console.error(e);
          message.reply('❌ 郵件寄送失敗，請確認郵箱設定是否正確。');
        }
      });
    return;
  }

  if (message.content.startsWith('!code ')) {
    const input = message.content.replace('!code ', '').trim();
    const userId = message.author.id;
    db.get(`SELECT * FROM pending WHERE user_id=? AND verified=0 ORDER BY created_at DESC LIMIT 1`, [userId], async (err, row) => {
      if (err || !row) return message.reply('❌ 尚未申請驗證，請先輸入 `!email 你的電子郵件`。');
      if (nowEpoch() > row.code_expires_at) return message.reply('⚠️ 驗證碼已過期，請重新申請。');
      if (sha256(input) !== row.code_hash) return message.reply('❌ 驗證碼錯誤，請重新輸入。');

      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) return message.reply('❌ 無法找到伺服器。');
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return message.reply('❌ 您不在伺服器中。');

      let role = guild.roles.cache.find(r => r.name === ROLE_NAME);
      if (!role) role = await guild.roles.create({ name: ROLE_NAME, reason: '自動驗證身分組' });
      await member.roles.add(role);

      db.run(`UPDATE pending SET verified=1 WHERE id=?`, [row.id]);
      message.reply(`✅ 驗證成功！您已獲得身分組 **${ROLE_NAME}** 🎉`);
    });
  }
});

client.once('ready', () => console.log(`🤖 Bot 已上線：${client.user.tag}`));

const express = require('express');
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 3000, () => console.log('✅ 保活伺服器已啟動'));

client.login(process.env.DISCORD_TOKEN);
