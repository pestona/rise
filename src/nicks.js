const {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const store = require('./store');
const { buildNicksPanel, v2Flags } = require('./ui');
const { truncate } = require('./util');

function panelPayload(settings) {
  return {
    components: [buildNicksPanel(settings)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };
}

function listNickEntries(guildId) {
  const entries = store.getGuild(guildId).nicks?.entries || [];
  return [...entries].sort((a, b) =>
    String(a.nick || '').localeCompare(String(b.nick || ''), 'ru', { sensitivity: 'base' }),
  );
}

function getNickEntry(guildId, userId) {
  return (store.getGuild(guildId).nicks?.entries || []).find((item) => item.userId === userId) || null;
}

function formatNickStatic(entry) {
  if (!entry?.nick) return '';
  return `${entry.nick} | ${entry.staticId || ''}`.trim();
}

function parseNickStatic(raw) {
  const text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = text.split('|').map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'Пиши так: `Name_Last | 12345`' };
  }

  const nick = truncate(parts[0], 32).trim();
  const staticId = truncate(parts[1].replace(/\s+/g, ''), 20);
  if (!nick || !staticId) {
    return { ok: false, error: 'Пиши так: `Name_Last | 12345`' };
  }
  if (/[<>@]/.test(nick) || /[<>@]/.test(staticId)) {
    return { ok: false, error: 'В нике и статике нельзя упоминания.' };
  }
  return { ok: true, nick, staticId };
}

function upsertNick(guildId, userId, nick, staticId) {
  const entry = {
    userId,
    nick,
    staticId,
    updatedAt: Date.now(),
  };
  store.updateGuild(guildId, (guild) => {
    if (!guild.nicks || !Array.isArray(guild.nicks.entries)) guild.nicks = { entries: [] };
    guild.nicks.entries = guild.nicks.entries.filter((item) => item.userId !== userId);
    guild.nicks.entries.push(entry);
  });
  return entry;
}

function removeNick(guildId, userId) {
  let removed = null;
  store.updateGuild(guildId, (guild) => {
    if (!guild.nicks || !Array.isArray(guild.nicks.entries)) return;
    removed = guild.nicks.entries.find((item) => item.userId === userId) || null;
    guild.nicks.entries = guild.nicks.entries.filter((item) => item.userId !== userId);
  });
  return removed;
}

function nickModal(customId, current = '') {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel('Ник | статик')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80)
    .setPlaceholder('Name_Last | 12345');
  const value = String(current || '').trim().slice(0, 80);
  if (value) input.setValue(value);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Ник и статик')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function refreshNicksPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const payload = panelPayload(settings);
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'nicks')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(payload);
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель ников:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function publishNicksPanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const payload = panelPayload(settings);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === 'nicks' && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      store.rememberPanel(interaction.guildId, {
        key: 'nicks',
        channelId: channel.id,
        messageId: message.id,
      });
      return { edited: true, message };
    } catch {
      // старое сообщение удалили — отправим новое
    }
  }

  if (channel.type === ChannelType.GuildForum) {
    throw new Error('forum');
  }

  const message = await channel.send(payload);
  store.rememberPanel(interaction.guildId, {
    key: 'nicks',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function handleNicksButton(interaction) {
  const action = interaction.customId.split(':')[1];
  if (action === 'delete') {
    const removed = removeNick(interaction.guildId, interaction.user.id);
    if (removed) await refreshNicksPanels(interaction.client, interaction.guildId).catch(() => null);
    return interaction.reply({
      content: removed ? 'Твой ник удалён из базы.' : 'У тебя ещё нет ника в базе.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action !== 'set') {
    return interaction.reply({
      content: 'Неизвестная кнопка.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = formatNickStatic(getNickEntry(interaction.guildId, interaction.user.id));
  return interaction.showModal(nickModal('nicks:modal', current));
}

async function handleNicksModal(interaction) {
  const parsed = parseNickStatic(interaction.fields.getTextInputValue('value'));
  if (!parsed.ok) {
    return interaction.reply({
      content: parsed.error,
      flags: MessageFlags.Ephemeral,
    });
  }

  upsertNick(interaction.guildId, interaction.user.id, parsed.nick, parsed.staticId);
  await refreshNicksPanels(interaction.client, interaction.guildId).catch(() => null);
  return interaction.reply({
    content: `Записал: **${parsed.nick} | ${parsed.staticId}**`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  listNickEntries,
  getNickEntry,
  formatNickStatic,
  parseNickStatic,
  upsertNick,
  removeNick,
  nickModal,
  publishNicksPanel,
  refreshNicksPanels,
  handleNicksButton,
  handleNicksModal,
};
