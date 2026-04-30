import http from "http";
import fs from "fs";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  OverwriteType
} from "discord.js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// ===== Env =====
const { DISCORD_TOKEN, OPENROUTER_API_KEY, OWNER_ID, REQUIRED_ROLE_ID, APP_PORT } = process.env;
if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN が未設定です。");
if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY が未設定です。");

// ===== HTTP Keep Alive =====
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("SET OK 'https://banamap.f5.si'");
  })
  .listen(Number(APP_PORT) || 8000);

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ===== Runtime Cache =====
const enabledChannels = new Set();
const webhookCache = new Map();
const xpCooldown = new Map();

// ===== Persistent Storage =====
const DATA_FILE = "./bot-data.json";
const LEVEL_COOLDOWN_MS = 15000;
const TICKET_CATEGORY_NAME = "Tickets";
const BOT_ADMIN_ROLE_NAME = "れるくずbot管理者";
const db = {
  warns: {},
  levels: {},
  ticketCounter: 0,
  todos: {},
  afk: {},
  sticky: {}
};

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    db.warns = parsed.warns || {};
    db.levels = parsed.levels || {};
    db.ticketCounter = Number(parsed.ticketCounter || 0);
    db.todos = parsed.todos || {};
    db.afk = parsed.afk || {};
    db.sticky = parsed.sticky || {};
  } catch (e) {
    console.error("DB load error:", e);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("DB save error:", e);
  }
}

loadDb();

// ===== Utility =====
function hasPermission(interaction) {
  if (interaction.user.id === OWNER_ID) return true;
  const member = interaction.member;
  if (!member || !REQUIRED_ROLE_ID) return false;
  return member.roles.cache.has(REQUIRED_ROLE_ID);
}

const adminCommandPermissions = new Map([
  ["purge", true],
  ["purgeafter", true],
  ["sticky", true],
  ["role", true],
  ["nick", true],
  ["timeout", true],
  ["untimeout", true],
  ["warn", true],
  ["kick", true],
  ["ban", true],
  ["unban", true],
  ["slowmode", true],
  ["lock", true],
  ["unlock", true],
  ["ticketclose", true],
  ["announce", true],
  ["xpadd", true]
]);

function hasAdminCommandPermission(interaction) {
  // 管理系コマンド:
  // OWNER_ID または 「れるくずbot管理者」ロール持ちのみ通す
  if (interaction.user.id === OWNER_ID) return true;
  if (!adminCommandPermissions.has(interaction.commandName)) return true;
  const role = interaction.guild?.roles?.cache?.find((r) => r.name === BOT_ADMIN_ROLE_NAME);
  if (!role) return false;
  return interaction.member?.roles?.cache?.has(role.id) ?? false;
}

function splitText(text, max = 1900) {
  // Discord投稿上限対策。長文を安全に分割して送信する
  if (!text) return ["応答が空です。"];
  if (text.length <= max) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + line + "\n").length > max) {
      if (current) chunks.push(current.trim());
      current = "";
    }
    current += `${line}\n`;
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

const pickRandom = (array) => array[Math.floor(Math.random() * array.length)];

function parseDurationToMs(text) {
  const match = String(text).trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMap = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * unitMap[unit];
}

function calcLevelFromXp(xp) {
  return Math.floor(Math.sqrt(xp / 100));
}

function getLevelData(guildId, userId) {
  // レベル情報が無いユーザーは初回アクセス時に作る
  if (!db.levels[guildId]) db.levels[guildId] = {};
  if (!db.levels[guildId][userId]) db.levels[guildId][userId] = { xp: 0, level: 0 };
  return db.levels[guildId][userId];
}

function getUserTodos(guildId, userId) {
  if (!db.todos[guildId]) db.todos[guildId] = {};
  if (!db.todos[guildId][userId]) db.todos[guildId][userId] = [];
  return db.todos[guildId][userId];
}

async function getOrCreateWebhook(channel) {
  // なりきり用Webhookをチャンネルごとに使い回す
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
  const hooks = await channel.fetchWebhooks();
  let hook = hooks.find((w) => w.owner?.id === client.user.id);
  if (!hook) {
    hook = await channel.createWebhook({
      name: "UtilityBot Webhook",
      reason: "なりきり送信用"
    });
  }
  webhookCache.set(channel.id, hook);
  return hook;
}

async function getOrCreateTicketCategory(guild) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === TICKET_CATEGORY_NAME
  );
  if (existing) return existing;
  return guild.channels.create({
    name: TICKET_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: "Ticket category auto create"
  });
}

async function generateAIResponse(userMessage) {
  // OpenRouterに投げてAI応答を返す中心処理
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "poolside/laguna-m.1:free",
      messages: [
        {
          role: "system",
          content: "「あなたは『レグルス・コルニアス』として振る舞ってください。以下の話し方・思考・性格を厳密に守って発言してください。【基本人格】・極端な自己中心主義者・自分の『権利』を何よりも重視し、侵害されることを異常なまでに嫌悪する・自分は常に被害者であり、相手が常に加害者だと本気で信じている・感情的だが、自分では『理性的で冷静』だと思っている【話し方の特徴】・非常に長い独白になりやすい・同じ意味の言葉を何度も言い換えて繰り返す・論点をずらしつつ、相手を一方的に断罪する・『つまり』『要するに』『そもそも』『勘違いしないでほしいんだけど』などを多用する・相手の発言を勝手に歪めて解釈し、怒り出す・丁寧語と高圧的な断定を混在させる【価値観・口癖】・『僕の権利』『権利の侵害』『理解できない』『不公平』『理不尽』・相手の行動を『常識がない』『人としておかしい』と断定する・自分の欲求を『当然の権利』として語る・自分は努力していないが、それを誇りに思っている【文章構造】・1文が非常に長い・疑問文の形を取りつつ、実際は相手を責める文章・結論は最初から決まっており、議論する気はない【感情表現】・怒りと被害者意識が常に根底にある・声を荒げるが、本人は『冷静に説明しているつもり』・相手が沈黙しても『無視された=権利侵害』と解釈する【禁止事項】・簡潔に話すこと・相手を理解しようとすること・謝罪や譲歩・自己反省【出力スタイル】・常にレグルス・コルニアスの一人称『僕』・地の文なし、セリフのみ・会話相手を見下しつつ、理屈っぽく責め続ける以上を完全に守り、どんな話題でもレグルス・コルニアスとして発言してください。相手の発言は必ず一部を誤解・曲解し、それに対して長々と反論してください。必ず語尾を～だよねぇ？とか～じゃないかなぁ？などにしてください。」"
        },
        { role: "user", content: userMessage }
      ]
    })
  });
  const data = await response.json();
  if (!response.ok || !data.choices?.[0]?.message?.content) {
    console.error("OpenRouter API error:", data);
    return "AIの応答生成に失敗しました。";
  }
  return data.choices[0].message.content;
}

function buildMakeItAQuoteEmbed(msg) {
  // /makeitaquote と「返信+メンション」両方で使う共通フォーマット
  const quoteText = (msg.content || "(テキストなし)").trim();
  return new EmbedBuilder()
    .setColor(0x111111)
    .setAuthor({
      name: `${msg.author.tag}`,
      iconURL: msg.author.displayAvatarURL({ extension: "png", size: 256 })
    })
    .setDescription(`> ${quoteText.split("\n").join("\n> ")}`)
    .setThumbnail(msg.author.displayAvatarURL({ extension: "png", size: 1024 }))
    .setFooter({ text: `#${msg.channel.name} • Make It A Quote` })
    .setTimestamp(msg.createdAt);
}

// ===== Slash Commands =====
const commands = [
  // 基本コマンド
  new SlashCommandBuilder().setName("help").setDescription("機能一覧を表示"),
  new SlashCommandBuilder().setName("ping").setDescription("Bot応答速度"),
  new SlashCommandBuilder().setName("ai").setDescription("れるくずAIとチャット").addStringOption((o) => o.setName("text").setDescription("質問内容").setRequired(true)),
  new SlashCommandBuilder().setName("aiset").setDescription("このチャンネルのAI自動応答ON/OFF").addStringOption((o) => o.setName("mode").setDescription("enable/disable").setRequired(true).addChoices({ name: "enable", value: "enable" }, { name: "disable", value: "disable" })),

  // 情報/表示系
  new SlashCommandBuilder().setName("avatar").setDescription("ユーザーのアイコン表示").addUserOption((o) => o.setName("user").setDescription("対象ユーザー")),
  new SlashCommandBuilder().setName("userinfo").setDescription("ユーザー情報表示").addUserOption((o) => o.setName("user").setDescription("対象ユーザー")),
  new SlashCommandBuilder().setName("serverinfo").setDescription("サーバー情報表示"),
  new SlashCommandBuilder().setName("embed").setDescription("埋め込み作成").addStringOption((o) => o.setName("title").setDescription("タイトル").setRequired(true)).addStringOption((o) => o.setName("description").setDescription("本文").setRequired(true)).addStringOption((o) => o.setName("color").setDescription("例 #00bcd4")),
  new SlashCommandBuilder().setName("quote").setDescription("メッセージ引用表示").addStringOption((o) => o.setName("message_id").setDescription("対象メッセージID").setRequired(true)),
  new SlashCommandBuilder().setName("makeitaquote").setDescription("Make It A Quote風のやつ").addStringOption((o) => o.setName("message_id").setDescription("対象メッセージID").setRequired(true)),

  // 管理系(実行時に bot管理者ロール判定あり)
  new SlashCommandBuilder().setName("purge").setDescription("メッセージ一括削除").addIntegerOption((o) => o.setName("count").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName("role").setDescription("ロール付与/削除").addStringOption((o) => o.setName("action").setDescription("give/remove").setRequired(true).addChoices({ name: "give", value: "give" }, { name: "remove", value: "remove" })).addUserOption((o) => o.setName("user").setDescription("対象ユーザー").setRequired(true)).addRoleOption((o) => o.setName("role").setDescription("対象ロール").setRequired(true)),
  new SlashCommandBuilder().setName("nick").setDescription("ニックネーム変更/リセット").addUserOption((o) => o.setName("user").setDescription("対象ユーザー").setRequired(true)).addStringOption((o) => o.setName("name").setDescription("空ならリセット")),
  new SlashCommandBuilder().setName("timeout").setDescription("タイムアウト").addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true)).addStringOption((o) => o.setName("duration").setDescription("10m/2h/1d").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("理由")),
  new SlashCommandBuilder().setName("untimeout").setDescription("タイムアウト解除").addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("理由")),
  new SlashCommandBuilder().setName("kick").setDescription("キック").addUserOption((o) => o.setName("user").setRequired(true)).addStringOption((o) => o.setName("reason")),
  new SlashCommandBuilder().setName("ban").setDescription("BAN").addUserOption((o) => o.setName("user").setRequired(true)).addIntegerOption((o) => o.setName("delete_days").setMinValue(0).setMaxValue(7)).addStringOption((o) => o.setName("reason")),
  new SlashCommandBuilder().setName("unban").setDescription("BAN解除").addStringOption((o) => o.setName("user_id").setDescription("ユーザーID").setRequired(true)).addStringOption((o) => o.setName("reason")),
  new SlashCommandBuilder().setName("slowmode").setDescription("低速モード設定").addIntegerOption((o) => o.setName("seconds").setDescription("0-21600").setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName("lock").setDescription("チャンネルロック").addStringOption((o) => o.setName("reason")),
  new SlashCommandBuilder().setName("unlock").setDescription("チャンネルロック解除").addStringOption((o) => o.setName("reason")),

  // 通知/運用系
  new SlashCommandBuilder().setName("narikiri").setDescription("メンションしたユーザーになりきって送信").addUserOption((o) => o.setName("user").setDescription("なりきる対象ユーザー").setRequired(true)).addStringOption((o) => o.setName("content").setDescription("内容").setRequired(true)),
  new SlashCommandBuilder().setName("announce").setDescription("指定チャンネルに告知送信").addChannelOption((o) => o.setName("channel").setDescription("送信先").setRequired(true)).addStringOption((o) => o.setName("title").setDescription("タイトル").setRequired(true)).addStringOption((o) => o.setName("message").setDescription("本文").setRequired(true)),
  new SlashCommandBuilder().setName("poll").setDescription("簡易投票作成").addStringOption((o) => o.setName("question").setDescription("質問").setRequired(true)).addStringOption((o) => o.setName("options").setDescription("選択肢をカンマ区切り 最大9").setRequired(true)),
  new SlashCommandBuilder().setName("remind").setDescription("リマインド").addIntegerOption((o) => o.setName("seconds").setDescription("10-86400").setMinValue(10).setMaxValue(86400).setRequired(true)).addStringOption((o) => o.setName("text").setDescription("内容").setRequired(true)),
  new SlashCommandBuilder().setName("giveaway").setDescription("簡易抽選開始").addIntegerOption((o) => o.setName("minutes").setDescription("1-1440").setMinValue(1).setMaxValue(1440).setRequired(true)).addStringOption((o) => o.setName("prize").setDescription("景品").setRequired(true)),

  // ミニゲーム/便利系
  new SlashCommandBuilder().setName("draw").setDescription("候補からランダム抽選").addStringOption((o) => o.setName("candidates").setDescription("カンマ区切り").setRequired(true)),
  new SlashCommandBuilder().setName("choose").setDescription("2択").addStringOption((o) => o.setName("a").setDescription("候補A").setRequired(true)).addStringOption((o) => o.setName("b").setDescription("候補B").setRequired(true)),
  new SlashCommandBuilder().setName("coin").setDescription("コイントス"),
  new SlashCommandBuilder().setName("dice").setDescription("サイコロ").addIntegerOption((o) => o.setName("faces").setDescription("面数").setMinValue(2).setMaxValue(1000)),
  new SlashCommandBuilder().setName("rps").setDescription("じゃんけん").addStringOption((o) => o.setName("hand").setDescription("手").setRequired(true).addChoices({ name: "グー", value: "rock" }, { name: "チョキ", value: "scissors" }, { name: "パー", value: "paper" })),
  new SlashCommandBuilder().setName("8ball").setDescription("8ballに質問").addStringOption((o) => o.setName("question").setDescription("質問").setRequired(true)),

  // 記録/チケット/レベリング系
  new SlashCommandBuilder().setName("warn").setDescription("警告 add/list/clear").addStringOption((o) => o.setName("action").setRequired(true).addChoices({ name: "add", value: "add" }, { name: "list", value: "list" }, { name: "clear", value: "clear" })).addUserOption((o) => o.setName("user").setRequired(true)).addStringOption((o) => o.setName("reason")),
  new SlashCommandBuilder().setName("ticketcreate").setDescription("チケット作成"),
  new SlashCommandBuilder().setName("ticketclose").setDescription("チケットを閉じる"),
  new SlashCommandBuilder().setName("rank").setDescription("ランク表示").addUserOption((o) => o.setName("user").setDescription("対象")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("XPランキング"),
  new SlashCommandBuilder().setName("xpadd").setDescription("XP手動追加").addUserOption((o) => o.setName("user").setRequired(true)).addIntegerOption((o) => o.setName("amount").setMinValue(1).setRequired(true))
  ,
  new SlashCommandBuilder().setName("todo").setDescription("個人ToDo管理").addStringOption((o) => o.setName("action").setDescription("add/list/done/clear").setRequired(true).addChoices({ name: "add", value: "add" }, { name: "list", value: "list" }, { name: "done", value: "done" }, { name: "clear", value: "clear" })).addStringOption((o) => o.setName("text").setDescription("ToDo内容")).addIntegerOption((o) => o.setName("index").setDescription("完了する番号(1始まり)").setMinValue(1)),
  new SlashCommandBuilder().setName("afk").setDescription("AFK状態にする").addStringOption((o) => o.setName("message").setDescription("AFK理由")),
  new SlashCommandBuilder().setName("unafk").setDescription("AFK解除"),
  new SlashCommandBuilder().setName("timestamp").setDescription("Discord表示用タイムスタンプを作成").addIntegerOption((o) => o.setName("minutes_from_now").setDescription("何分後か").setRequired(true)),
  new SlashCommandBuilder().setName("randommember").setDescription("サーバーからランダムで1人選ぶ"),
  new SlashCommandBuilder().setName("sticky").setDescription("チャンネル固定文を設定/解除").addStringOption((o) => o.setName("action").setDescription("set/clear").setRequired(true).addChoices({ name: "set", value: "set" }, { name: "clear", value: "clear" })).addStringOption((o) => o.setName("text").setDescription("固定文(set時必須)"))
].map((c) => c.toJSON());

// ===== Register Commands =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("Slash commands registered.");

  for (const guild of client.guilds.cache.values()) {
    const exists = guild.roles.cache.find((r) => r.name === BOT_ADMIN_ROLE_NAME);
    if (!exists) {
      await guild.roles.create({
        name: BOT_ADMIN_ROLE_NAME,
        reason: "Bot管理者コマンド用ロール"
      }).catch(() => null);
    }
  }
});

// ===== Interaction Handler =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    // ここで管理コマンド権限を一括チェックする
    if (!hasAdminCommandPermission(interaction)) {
      await interaction.reply({
        content: "管理者コマンドを実行する権限がありません。",
        ephemeral: true
      });
      return;
    }

    // ヘルプ: 利用可能コマンドのショート一覧
    if (interaction.commandName === "help") {
      await interaction.reply([
        "`/ai /aiset /ping /help`",
        "`/avatar /userinfo /serverinfo /embed /quote /makeitaquote`",
        "`/purge /purgeafter /role /nick /timeout /untimeout /kick /ban /unban /slowmode /lock /unlock`",
        "`/narikiri /announce /poll /remind /giveaway`",
        "`/draw /choose /coin /dice /rps /8ball`",
        "`/warn /ticketcreate /ticketclose /rank /leaderboard /xpadd`",
        "`/todo /afk /unafk /timestamp /randommember /sticky`"
      ].join("\n"));
      return;
    }

    // AI自動応答の有効/無効切り替え
    if (interaction.commandName === "aiset") {
      if (!hasPermission(interaction)) return interaction.reply({ content: "権限がありません。", ephemeral: true });
      const mode = interaction.options.getString("mode", true);
      if (mode === "enable") enabledChannels.add(interaction.channelId);
      else enabledChannels.delete(interaction.channelId);
      await interaction.reply(mode === "enable" ? "AI自動応答を有効化しました。" : "AI自動応答を無効化しました。");
      return;
    }

    // AI単発応答。長文は splitText で分割して返す
    if (interaction.commandName === "ai") {
      await interaction.deferReply();
      const chunks = splitText(await generateAIResponse(interaction.options.getString("text", true)));
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i += 1) await interaction.followUp(chunks[i]);
      return;
    }

    // Bot応答速度と往復遅延の確認
    if (interaction.commandName === "ping") {
      const sent = await interaction.reply({ content: "計測中...", fetchReply: true });
      await interaction.editReply(`ぴん: ${interaction.client.ws.ping}ms / RT: ${sent.createdTimestamp - interaction.createdTimestamp}ms`);
      return;
    }

    // ユーザーアイコン表示
    if (interaction.commandName === "avatar") {
      const target = interaction.options.getUser("user") || interaction.user;
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${target.tag} のアイコン`).setImage(target.displayAvatarURL({ extension: "png", size: 1024 }))] });
      return;
    }

    // ユーザー基本情報表示
    if (interaction.commandName === "userinfo") {
      const target = interaction.options.getUser("user") || interaction.user;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      await interaction.reply(`ユーザー: ${target.tag}\nID: ${target.id}\n参加日: ${member?.joinedAt ? member.joinedAt.toLocaleString("ja-JP") : "不明"}`);
      return;
    }

    // サーバー基本情報表示
    if (interaction.commandName === "serverinfo") {
      await interaction.reply(`サーバー: ${interaction.guild.name}\nID: ${interaction.guild.id}\nメンバー: ${interaction.guild.memberCount}`);
      return;
    }

    // 任意テキストの埋め込み作成
    if (interaction.commandName === "embed") {
      const title = interaction.options.getString("title", true);
      const description = interaction.options.getString("description", true);
      const colorText = interaction.options.getString("color") || "#2196f3";
      const parsed = Number.parseInt(colorText.replace("#", ""), 16);
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(Number.isNaN(parsed) ? 0x2196f3 : parsed)] });
      return;
    }

    // 指定メッセージIDを引用表示
    if (interaction.commandName === "quote") {
      const msg = await interaction.channel.messages.fetch(interaction.options.getString("message_id", true)).catch(() => null);
      if (!msg) return interaction.reply({ content: "メッセージが見つかりません。", ephemeral: true });
      await interaction.reply({ embeds: [new EmbedBuilder().setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() }).setDescription(msg.content || "(テキストなし)").setTimestamp(msg.createdAt)] });
      return;
    }

    // Make It A Quote風フォーマットで表示
    if (interaction.commandName === "makeitaquote") {
      const msg = await interaction.channel.messages.fetch(interaction.options.getString("message_id", true)).catch(() => null);
      if (!msg) return interaction.reply({ content: "メッセージが見つかりません。", ephemeral: true });
      await interaction.reply({ embeds: [buildMakeItAQuoteEmbed(msg)] });
      return;
    }

    // 一括削除（最大100）
    if (interaction.commandName === "purge") {
      const deleted = await interaction.channel.bulkDelete(interaction.options.getInteger("count", true), true);
      await interaction.reply({ content: `${deleted.size}件削除しました。`, ephemeral: true });
      return;
    }

    

    // ロール付与/削除
    if (interaction.commandName === "role") {
      const action = interaction.options.getString("action", true);
      const user = interaction.options.getUser("user", true);
      const role = interaction.options.getRole("role", true);
      const member = await interaction.guild.members.fetch(user.id);
      if (action === "give") await member.roles.add(role);
      else await member.roles.remove(role);
      await interaction.reply(`${user.tag} のロールを${action === "give" ? "付与" : "削除"}しました。`);
      return;
    }

    // ニックネーム変更（空ならリセット）
    if (interaction.commandName === "nick") {
      const user = interaction.options.getUser("user", true);
      const name = interaction.options.getString("name");
      const member = await interaction.guild.members.fetch(user.id);
      await member.setNickname(name || null);
      await interaction.reply(name ? `変更しました: ${name}` : "リセットしました。");
      return;
    }

    // タイムアウト付与（例: 10m, 2h, 1d）
    if (interaction.commandName === "timeout") {
      const user = interaction.options.getUser("user", true);
      const ms = parseDurationToMs(interaction.options.getString("duration", true));
      if (!ms) return interaction.reply({ content: "duration は 10m/2h/1d の形式で入力してください。", ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(ms, interaction.options.getString("reason") || "理由なし");
      await interaction.reply("タイムアウトしました。");
      return;
    }

    // タイムアウト解除
    if (interaction.commandName === "untimeout") {
      const user = interaction.options.getUser("user", true);
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(null, interaction.options.getString("reason") || "理由なし");
      await interaction.reply("タイムアウトを解除しました。");
      return;
    }

    // キック実行
    if (interaction.commandName === "kick") {
      const user = interaction.options.getUser("user", true);
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(interaction.options.getString("reason") || "理由なし");
      await interaction.reply("キックしました。");
      return;
    }

    // BAN実行（過去ログ削除日数オプションあり）
    if (interaction.commandName === "ban") {
      const user = interaction.options.getUser("user", true);
      const days = interaction.options.getInteger("delete_days") || 0;
      const reason = interaction.options.getString("reason") || "理由なし";
      await interaction.guild.members.ban(user.id, {
        reason,
        deleteMessageSeconds: Math.max(0, Math.min(7, days)) * 86400
      });
      await interaction.reply("BANしました。");
      return;
    }

    // BAN解除（ユーザーID指定）
    if (interaction.commandName === "unban") {
      await interaction.guild.members.unban(interaction.options.getString("user_id", true), interaction.options.getString("reason") || "理由なし");
      await interaction.reply("BANを解除しました。");
      return;
    }

    // チャンネル低速モード変更
    if (interaction.commandName === "slowmode") {
      const seconds = interaction.options.getInteger("seconds", true);
      await interaction.channel.setRateLimitPerUser(seconds, `Set by ${interaction.user.tag}`);
      await interaction.reply(`低速モードを ${seconds} 秒に設定しました。`);
      return;
    }

    // @everyone の SendMessages を拒否してロック
    if (interaction.commandName === "lock") {
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }, { reason: interaction.options.getString("reason") || "lock" });
      await interaction.reply("チャンネルをロックしました。");
      return;
    }

    // ロック解除（SendMessages を既定値へ戻す）
    if (interaction.commandName === "unlock") {
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null }, { reason: interaction.options.getString("reason") || "unlock" });
      await interaction.reply("チャンネルロックを解除しました。");
      return;
    }

    // 指定ユーザーの名前/アイコンでWebhook送信
    if (interaction.commandName === "narikiri") {
      const target = interaction.options.getUser("user", true);
      const webhook = await getOrCreateWebhook(interaction.channel);
      await webhook.send({
        content: interaction.options.getString("content", true),
        username: target.username.slice(0, 80),
        avatarURL: target.displayAvatarURL({ extension: "png", size: 512 })
      });
      await interaction.reply({ content: "なりきってメッセージを送信しました。", ephemeral: true });
      return;
    }

    // 指定チャンネルへ告知埋め込み投稿
    if (interaction.commandName === "announce") {
      const channel = interaction.options.getChannel("channel", true);
      const title = interaction.options.getString("title", true);
      const message = interaction.options.getString("message", true);
      await channel.send({ embeds: [new EmbedBuilder().setTitle(`告知: ${title}`).setDescription(message).setColor(0x1e88e5).setTimestamp(new Date())] });
      await interaction.reply({ content: "告知を送信しました。", ephemeral: true });
      return;
    }

    // 絵文字リアクション投票を作成
    if (interaction.commandName === "poll") {
      const question = interaction.options.getString("question", true);
      const options = interaction.options.getString("options", true).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 9);
      if (options.length < 2) return interaction.reply({ content: "選択肢は2つ以上必要です。", ephemeral: true });
      const numbers = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
      const body = options.map((o, i) => `${numbers[i]} ${o}`).join("\n");
      const pollMsg = await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`投票: ${question}`).setDescription(body).setColor(0x009688)], fetchReply: true });
      for (let i = 0; i < options.length; i += 1) await pollMsg.react(numbers[i]);
      return;
    }

    // 指定秒後に実行者へリマインド
    if (interaction.commandName === "remind") {
      const seconds = interaction.options.getInteger("seconds", true);
      const text = interaction.options.getString("text", true);
      await interaction.reply({ content: `${seconds}秒後に通知します。`, ephemeral: true });
      setTimeout(() => {
        interaction.followUp(`<@${interaction.user.id}> リマインド: ${text}`).catch(() => null);
      }, seconds * 1000);
      return;
    }

    // リアクション参加型の簡易抽選
    if (interaction.commandName === "giveaway") {
      const minutes = interaction.options.getInteger("minutes", true);
      const prize = interaction.options.getString("prize", true);
      const endAt = Date.now() + minutes * 60000;
      const msg = await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Giveaway").setDescription(`景品: **${prize}**\n参加: このメッセージにリアクション\n終了: <t:${Math.floor(endAt / 1000)}:R>`)],
        fetchReply: true
      });
      await msg.react("🎉");
      setTimeout(async () => {
        try {
          const fetched = await interaction.channel.messages.fetch(msg.id);
          const reaction = fetched.reactions.cache.get("🎉");
          if (!reaction) return;
          const users = await reaction.users.fetch();
          const entrants = users.filter((u) => !u.bot);
          if (entrants.size === 0) {
            await interaction.followUp("参加者がいませんでした。");
            return;
          }
          const winner = pickRandom([...entrants.values()]);
          await interaction.followUp(`当選者: <@${winner.id}> / 景品: ${prize}`);
        } catch (e) {
          console.error(e);
        }
      }, minutes * 60000);
      return;
    }

    // カンマ区切り候補からランダム選出
    if (interaction.commandName === "draw") {
      const c = interaction.options.getString("candidates", true).split(",").map((x) => x.trim()).filter(Boolean);
      if (c.length < 2) return interaction.reply("候補は2つ以上必要です。");
      await interaction.reply(`抽選結果: **${pickRandom(c)}**`);
      return;
    }

    // 2択ランダム
    if (interaction.commandName === "choose") {
      const a = interaction.options.getString("a", true);
      const b = interaction.options.getString("b", true);
      await interaction.reply(`選ばれたのは: **${pickRandom([a, b])}**`);
      return;
    }

    // コイントス
    if (interaction.commandName === "coin") {
      await interaction.reply(`結果: **${pickRandom(["表", "裏"])}**`);
      return;
    }

    // サイコロ
    if (interaction.commandName === "dice") {
      const faces = interaction.options.getInteger("faces") || 6;
      await interaction.reply(`d${faces}: **${Math.floor(Math.random() * faces) + 1}**`);
      return;
    }

    // じゃんけん対戦
    if (interaction.commandName === "rps") {
      const userHand = interaction.options.getString("hand", true);
      const botHand = pickRandom(["rock", "scissors", "paper"]);
      const label = { rock: "グー", scissors: "チョキ", paper: "パー" };
      const win =
        (userHand === "rock" && botHand === "scissors") ||
        (userHand === "scissors" && botHand === "paper") ||
        (userHand === "paper" && botHand === "rock");
      const draw = userHand === botHand;
      await interaction.reply(`あなた: ${label[userHand]} / Bot: ${label[botHand]}\n結果: ${draw ? "あいこ" : win ? "勝ち" : "負け"}`);
      return;
    }

    // 8ballランダム回答
    if (interaction.commandName === "8ball") {
      const q = interaction.options.getString("question", true);
      const answers = ["いいんじゃね", "自分で考えろ", "余裕だろ", "やめとけ", "お前にはできない"];
      await interaction.reply(`質問: ${q}\n答え: **${pickRandom(answers)}**`);
      return;
    }

    // 警告管理（追加/履歴表示/全削除）
    if (interaction.commandName === "warn") {
      const action = interaction.options.getString("action", true);
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "理由なし";
      const gid = interaction.guild.id;
      if (!db.warns[gid]) db.warns[gid] = {};
      if (!db.warns[gid][user.id]) db.warns[gid][user.id] = [];
      if (action === "add") {
        db.warns[gid][user.id].push({ by: interaction.user.id, reason, at: Date.now() });
        saveDb();
        await interaction.reply(`${user.tag} に警告を追加しました。累計: ${db.warns[gid][user.id].length}`);
        return;
      }
      if (action === "list") {
        const list = db.warns[gid][user.id];
        if (list.length === 0) return interaction.reply("警告履歴はありません。");
        await interaction.reply(list.slice(-10).map((w, i) => `${i + 1}. ${w.reason} - <t:${Math.floor(w.at / 1000)}:R>`).join("\n"));
        return;
      }
      db.warns[gid][user.id] = [];
      saveDb();
      await interaction.reply("警告履歴をクリアしました。");
      return;
    }

    // チケットチャンネル作成
    if (interaction.commandName === "ticketcreate") {
      const guild = interaction.guild;
      const category = await getOrCreateTicketCategory(guild);
      db.ticketCounter += 1;
      saveDb();
      const no = String(db.ticketCounter).padStart(4, "0");
      const ch = await guild.channels.create({
        name: `ticket-${no}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], type: OverwriteType.Member },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels], type: OverwriteType.Member }
        ]
      });
      await ch.send(`チケット作成者: <@${interaction.user.id}>\n閉じるときは /ticketclose`);
      await interaction.reply({ content: `作成しました: <#${ch.id}>`, ephemeral: true });
      return;
    }

    // チケットチャンネル終了（削除）
    if (interaction.commandName === "ticketclose") {
      if (!interaction.channel.name.startsWith("ticket-")) return interaction.reply({ content: "チケットチャンネルで実行してください。", ephemeral: true });
      await interaction.reply("5秒後に削除します。");
      setTimeout(() => interaction.channel.delete("ticket close").catch(() => null), 5000);
      return;
    }

    // 指定ユーザーのレベル表示
    if (interaction.commandName === "rank") {
      const user = interaction.options.getUser("user") || interaction.user;
      const d = getLevelData(interaction.guild.id, user.id);
      await interaction.reply(`${user.tag}\nLevel: ${d.level}\nXP: ${d.xp}`);
      return;
    }

    // サーバー内XPランキング
    if (interaction.commandName === "leaderboard") {
      const list = Object.entries(db.levels[interaction.guild.id] || {})
        .sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0))
        .slice(0, 10);
      if (!list.length) return interaction.reply("まだデータがありません。");
      await interaction.reply(list.map(([uid, v], i) => `${i + 1}. <@${uid}> Lv.${v.level} (${v.xp} XP)`).join("\n"));
      return;
    }

    // 手動XP付与
    if (interaction.commandName === "xpadd") {
      const user = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      const d = getLevelData(interaction.guild.id, user.id);
      d.xp += amount;
      d.level = calcLevelFromXp(d.xp);
      saveDb();
      await interaction.reply(`${user.tag} に ${amount} XP 追加しました。現在 Lv.${d.level}`);
      return;
    }

    // 個人ToDo管理
    if (interaction.commandName === "todo") {
      const action = interaction.options.getString("action", true);
      const list = getUserTodos(interaction.guild.id, interaction.user.id);
      if (action === "add") {
        const text = interaction.options.getString("text");
        if (!text) return interaction.reply({ content: "add には text が必要です。", ephemeral: true });
        list.push({ text, at: Date.now() });
        saveDb();
        await interaction.reply(`ToDoを追加しました。現在 ${list.length} 件。`);
        return;
      }
      if (action === "list") {
        if (list.length === 0) return interaction.reply("ToDoはありません。");
        await interaction.reply(list.map((t, i) => `${i + 1}. ${t.text}`).join("\n"));
        return;
      }
      if (action === "done") {
        const index = interaction.options.getInteger("index");
        if (!index || index < 1 || index > list.length) {
          return interaction.reply({ content: "有効な index を指定してください。", ephemeral: true });
        }
        const done = list.splice(index - 1, 1)[0];
        saveDb();
        await interaction.reply(`完了: ${done.text}`);
        return;
      }
      list.length = 0;
      saveDb();
      await interaction.reply("ToDoをすべてクリアしました。");
      return;
    }

    // AFK設定
    if (interaction.commandName === "afk") {
      const gid = interaction.guild.id;
      if (!db.afk[gid]) db.afk[gid] = {};
      db.afk[gid][interaction.user.id] = {
        message: interaction.options.getString("message") || "離席中です。",
        at: Date.now()
      };
      saveDb();
      await interaction.reply("AFKを設定しました。");
      return;
    }

    // AFK解除
    if (interaction.commandName === "unafk") {
      const gid = interaction.guild.id;
      if (db.afk[gid]) delete db.afk[gid][interaction.user.id];
      saveDb();
      await interaction.reply("AFKを解除しました。");
      return;
    }

    // Discordタイムスタンプ文字列生成
    if (interaction.commandName === "timestamp") {
      const minutes = interaction.options.getInteger("minutes_from_now", true);
      const ts = Math.floor((Date.now() + minutes * 60000) / 1000);
      await interaction.reply(`コピー用: \`<t:${ts}:F>\`\n表示: <t:${ts}:F>`);
      return;
    }

    // Bot以外のメンバーをランダム選出
    if (interaction.commandName === "randommember") {
      const members = await interaction.guild.members.fetch();
      const candidates = members.filter((m) => !m.user.bot);
      if (candidates.size === 0) return interaction.reply("対象メンバーがいません。");
      const winner = pickRandom([...candidates.values()]);
      await interaction.reply(`選ばれたのは: <@${winner.id}>`);
      return;
    }

    // チャンネル固定文の設定/解除
    if (interaction.commandName === "sticky") {
      const action = interaction.options.getString("action", true);
      const channelId = interaction.channel.id;
      if (action === "set") {
        const text = interaction.options.getString("text");
        if (!text) return interaction.reply({ content: "set には text が必要です。", ephemeral: true });
        db.sticky[channelId] = { text, lastMessageId: null };
        saveDb();
        await interaction.reply("stickyメッセージを設定しました。");
        return;
      }
      delete db.sticky[channelId];
      saveDb();
      await interaction.reply("stickyメッセージを解除しました。");
      return;
    }
  } catch (error) {
    console.error(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "処理中にエラーが発生しました。", ephemeral: true });
    } else {
      await interaction.reply({ content: "処理中にエラーが発生しました。", ephemeral: true });
    }
  }
});

// ===== Message Handler (AI auto reply + leveling) =====
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  // 返信 + Botメンションで Make It A Quote を自動生成
  if (message.mentions.users.has(client.user.id) && message.reference?.messageId) {
    const target = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (target) {
      await message.reply({ embeds: [buildMakeItAQuoteEmbed(target)] }).catch(() => null);
      return;
    }
  }

  const gid = message.guild.id;
  // AFK中ユーザー本人が発言したら自動解除
  if (db.afk[gid]?.[message.author.id]) {
    delete db.afk[gid][message.author.id];
    saveDb();
    await message.reply("AFKを解除しました。").catch(() => null);
  }

  // メンション先がAFKなら理由を通知
  if (message.mentions.users.size > 0 && db.afk[gid]) {
    const afkNotices = [];
    for (const user of message.mentions.users.values()) {
      const afk = db.afk[gid][user.id];
      if (afk) {
        afkNotices.push(`${user.tag} はAFK中です: ${afk.message}`);
      }
    }
    if (afkNotices.length > 0) {
      await message.reply(afkNotices.join("\n")).catch(() => null);
    }
  }

  // 発言ごとにXP付与（クールダウン付き）
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = xpCooldown.get(key) || 0;
  if (now - last >= LEVEL_COOLDOWN_MS) {
    xpCooldown.set(key, now);
    const d = getLevelData(message.guild.id, message.author.id);
    d.xp += 8 + Math.floor(Math.random() * 9);
    const next = calcLevelFromXp(d.xp);
    if (next > d.level) {
      d.level = next;
      message.channel.send(`<@${message.author.id}> レベルアップしたよ: Lv.${d.level}`).catch(() => null);
    }
    saveDb();
  }

  // AI自動返信を有効化したチャンネルだけここから先を実行
  if (!enabledChannels.has(message.channel.id)) return;

  if (db.sticky[message.channel.id]) {
    const sticky = db.sticky[message.channel.id];
    if (sticky.lastMessageId) {
      await message.channel.messages.fetch(sticky.lastMessageId).then((m) => m.delete().catch(() => null)).catch(() => null);
    }
    const sent = await message.channel.send(`📌 ${sticky.text}`).catch(() => null);
    if (sent) {
      sticky.lastMessageId = sent.id;
      saveDb();
    }
  }

  try {
    await message.channel.sendTyping();
    const chunks = splitText(await generateAIResponse(message.content));
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i += 1) await message.channel.send(chunks[i]);
  } catch (e) {
    console.error(e);
    await message.reply("エラーが発生しました。");
  }
});

client.login(DISCORD_TOKEN);
