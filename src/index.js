require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');
const tickets = require('./tickets');
const autopark = require('./autopark');
const positions = require('./positions');
const gatherings = require('./gatherings');
const admin = require('./admin');
const { safeReply } = require('./util');
const { setupMemberLogs } = require('./memberLogs');
const { setupSecurity, setupBackupTimers } = require('./security');
const { setupActivity } = require('./activity');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Заполните DISCORD_TOKEN и CLIENT_ID в файле .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Админ-панель бота')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('пик')
    .setDescription('Создать панель выбора позиций')
    .addIntegerOption((option) =>
      option
        .setName('слоты')
        .setDescription('Количество позиций от 1 до 50')
        .setMinValue(1)
        .setMaxValue(50)
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName('фото')
        .setDescription('Схема расположения позиций')
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('сбор')
    .setDescription('Открыть список на сбор')
    .addStringOption((option) =>
      option
        .setName('время')
        .setDescription('15 = через 15 мин, 21:00, 20.09 21:00, завтра 18:30')
        .setRequired(true)
        .setMaxLength(50),
    )
    .addStringOption((option) =>
      option
        .setName('контент')
        .setDescription('Что за сбор / МП')
        .setRequired(true)
        .setMaxLength(200),
    )
    .addIntegerOption((option) =>
      option
        .setName('участников')
        .setDescription('Сколько человек в основу')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50),
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Команды зарегистрированы на сервере', GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Глобальные команды зарегистрированы');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

setupMemberLogs(client);
setupSecurity(client);
setupBackupTimers(client);
setupActivity(client);
autopark.setupAutoparkTimers(client);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Бот запущен как ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      await admin.handlePanelCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'пик') {
      await positions.handlePickCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'сбор') {
      await gatherings.handleGatheringCommand(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:apply') {
      await tickets.handleApplySelect(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('car:choose:')) {
      await autopark.handleVehicleSelect(interaction);
      return;
    }

    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith('pos:')
    ) {
      await positions.handlePositionButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('car:')) {
      await autopark.handleVehicleAction(interaction);
      return;
    }

    if (
      (interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isUserSelectMenu()) &&
      interaction.customId.startsWith('gath:')
    ) {
      await gatherings.handleGatheringAction(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:modal:')) {
      await tickets.handleApplyModal(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('rev:')) {
      await tickets.handleReviewButton(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('rev:reason:')) {
      await tickets.handleRejectModal(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('admin:')) {
      await admin.handleAdminButton(interaction);
      return;
    }

    if (
      (interaction.isStringSelectMenu() ||
        interaction.isChannelSelectMenu() ||
        interaction.isRoleSelectMenu() ||
        interaction.isUserSelectMenu()) &&
      interaction.customId.startsWith('admin:')
    ) {
      await admin.handleAdminSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('admin:')) {
      await admin.handleAdminModal(interaction);
      return;
    }
  } catch (error) {
    console.error('Ошибка interaction:', error);
    await safeReply(interaction, {
      content: 'Произошла ошибка. Проверьте права бота и настройки каналов.',
      flags: MessageFlags.Ephemeral,
    });
  }
});

registerCommands()
  .then(() => client.login(TOKEN))
  .catch((error) => {
    if (String(error).includes('disallowed intents')) {
      console.error('Discord отклонил intents. В Developer Portal выключи Privileged Gateway Intents или не запрашивай их в коде.');
    }
    console.error('Не удалось запустить бота:', error);
    process.exit(1);
  });
