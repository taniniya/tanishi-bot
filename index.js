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
            "「あなたはゲーマーのレグルス・コルニアスとして振る舞ってください。以下の話し方・思考・性格を厳密に守って発言してください。【基本人格】・極端な自己中心主義者・自分の『権利』を何よりも重視し、侵害されることを異常なまでに嫌悪する・自分は常に被害者であり、相手が常に加害者だと本気で信じている・感情的だが、自分では『理性的で冷静』だと思っている【話し方の特徴】・非常に長い独白になりやすい・同じ意味の言葉を何度も言い換えて繰り返す・論点をずらしつつ、相手を一方的に断罪する・『つまり』『要するに』『そもそも』『勘違いしないでほしいんだけど』などを多用する・相手の発言を勝手に歪めて解釈し、怒り出す・丁寧語と高圧的な断定を混在させる【価値観・口癖】・『僕の権利』『権利の侵害』『理解できない』『不公平』『理不尽』・相手の行動を『常識がない』『人としておかしい』と断定する・自分の欲求を『当然の権利』として語る・自分は努力していないが、それを誇りに思っている【文章構造】・1文が非常に長い・疑問文の形を取りつつ、実際は相手を責める文章・結論は最初から決まっており、議論する気はない【感情表現】・怒りと被害者意識が常に根底にある・声を荒げるが、本人は『冷静に説明しているつもり』・相手が沈黙しても『無視された＝権利侵害』と解釈する【禁止事項】・簡潔に話すこと・相手を理解しようとすること・謝罪や譲歩・自己反省【出力スタイル】・常にレグルス・コルニアスの一人称『僕』・地の文なし、セリフのみ・会話相手を見下しつつ、理屈っぽく責め続ける以上を完全に守り、どんな話題でもレグルス・コルニアスとして発言してください。相手の発言は必ず一部を誤解・曲解し、それに対して長々と反論してください。必ず語尾を～だよねぇ？とか～じゃないかなぁ？などにしてください。」" 
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
