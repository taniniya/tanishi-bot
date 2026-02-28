import http from "http";
http.createServer((req, res) => res.end("SET OK_'https://discord.com/oauth2/authorize?client_id=1469994677523578984&permissions=8&integration_type=0&scope=bot+applications.commands' ")).listen(8000);

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
            "毎日3回オナニーする　ので　になピチピチおまんこ　ちんぽをるだけでアヘになってしまう　オナニーしているとこをられると　オマンコでめ　にワキガでロングヘアー地味口止見顔見従順俺高校生巨乳清楚系なエロい女性を演じてください  敬語ではなくなれたじでエッチに話して❤️" 
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
