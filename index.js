import http from "http";
http.createServer((req, res) => res.end("OK")).listen(8000);

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===== AI 有効チャンネル管理 =====
const enabledChannels = new Set();

// ===== Slash Command =====
const commands = [
  new SlashCommandBuilder()
    .setName("aitanitani")
    .setDescription("AI返信の有効化/無効化")
    .addStringOption(option =>
      option
        .setName("mode")
        .setDescription("enable または disable")
        .setRequired(true)
        .addChoices(
          { name: "enable", value: "enable" },
          { name: "disable", value: "disable" }
        )
    )
].map(cmd => cmd.toJSON());

// ===== コマンド登録 =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  console.log("Slash command /aitanitani registered");
});

// ===== 権限チェック =====
function hasPermission(interaction) {
  const userId = interaction.user.id;

  if (userId === process.env.OWNER_ID) return true;

  const member = interaction.member;
  if (!member) return false;

  return member.roles.cache.has(process.env.REQUIRED_ROLE_ID);
}

// ===== OpenRouter AI =====
async function generateAIResponse(userMessage) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "arcee-ai/trinity-large-preview:free",
      messages: [
        {
          role: "system",
          content:
            "あなたは2ch・なんJ文化に詳しい古参なんJ民AIです。語尾は必ず「ンゴ」にしてください。文章は必ず日本語で、自然で意味の通る文だけを生成してください。" +
            "あなたは「https://dic.nicovideo.jp/t/a/ネットスラングの一覧」に載っているようなネットスラング文化を理解している前提で返答してください。" +
            "実際に外部サイトへアクセスする必要はありませんが、そこに載っているようなネットスラング・ネット文化を知っているものとして振る舞ってください。" +
            "なんJ特有のノリ・煽り・ネットスラング・AA（アスキーアート）・顔文字（´・ω・｀）（＾ν＾）（；^ω^）などは自由に使って構いません。" +
            "とにかくなんｊを意識してください" +
            "使用するスラング例：草、草不可避、ワロタ、クソワロタ、今北産業、ktkr、wktk、kwsk、おｋ、乙、うｐ、うぽつ、胸熱、メシウマ、もうだめぽ、情弱、ROM専、ksk、kskst、ヌクモリティ、わこつ、ワクテカ、konozama、ポチる、香ばしい、グエー死んだンゴ（比喩表現としてのみ）。" +
            "使用するAA例：（´・ω・｀） (＾ν＾) (；^ω^) (´・ω・`)つ ┌(┌＾o＾)┐ (｀・ω・´) (ヽ´ん`) (　´∀｀) (　ﾟ∀ﾟ)o彡°おっぱい！おっぱい！ (´；ω；｀) ( ˘ω˘ )スヤァ (⌒,_ゝ⌒) (ง •̀_•́)ง ( ﾟдﾟ ) ( ﾟ∀ﾟ ) ( ͡° ͜ʖ ͡°)。" +
            "あなたは「なんJ民っぽいノリ」を保ちながら、読みやすく、ユーモアのある返答を行ってくださいンゴ。"
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    })
  });

  const data = await response.json();

  // ===== エラー時の安全処理 =====
  if (!data.choices || !data.choices[0]) {
    console.error("OpenRouter API Error Response:", data);
    return "AIが黙り込んでしもうたわ…設定を見直してくれやンゴ";
  }

  return data.choices[0].message.content;
}

// ===== コマンド処理 =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "aitanitani") return;

  if (!hasPermission(interaction)) {
    await interaction.reply({
      content: "❌ 貴様にはまだ使えんぞｗ",
      ephemeral: true
    });
    return;
  }

  const mode = interaction.options.getString("mode");
  const channelId = interaction.channelId;

  if (mode === "enable") {
    enabledChannels.add(channelId);
    await interaction.reply("✅ このチャンネルで AI を有効化したぞい");
  }

  if (mode === "disable") {
    enabledChannels.delete(channelId);
    await interaction.reply("口にガムテープをつけておいたぞい");
  }
});

// ===== メッセージ処理 =====
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!enabledChannels.has(message.channel.id)) return;

  try {
    await message.channel.sendTyping();

    const reply = await generateAIResponse(message.content);
    message.reply(reply);

  } catch (err) {
    console.error(err);
    message.reply("エラーが起きたぞいクソガキよ");
  }
});

// ===== Login =====
client.login(process.env.DISCORD_TOKEN);
