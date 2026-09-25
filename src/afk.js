const {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const store = require('./store');
const { buildAfkList, buildAfkPanel, formatAfkDuration, v2Flags } = require('./ui');
const { truncate } = require('./util');

const MIN_AFK_MS = 60_000;
const MAX_AFK_MS = 24 * 60 * 60 * 1000;

function panelPayload(settings) {
  return {
    components: [buildAfkPanel(settings)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };
}

function pruneExpired(guildId) {
  const now = Date.now();
  const current = store.getGuild(guildId).afk?.entries || [];
  if (!current.some((entry) => entry.endsAt <= now)) return false;
  store.updateGuild(guildId, (guild) => {
    guild.afk.entries = (guild.afk.entries || []).filter((entry) => entry.endsAt > now);
  });
  return true;
}

function parseAfkDuration(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;

  const hourMatch = text.match(/(\d+)\s*(?:ч|h|час(?:а|ов)?)/);
  const minMatch = text.match(/(\d+)\s*(?:м|m|мин(?:ут[аы]?)?)/);
  if (!hourMatch && !minMatch) return null;

  const hours = hourMatch ? Number(hourMatch[1]) : 0;
  const minutes = minMatch ? Number(minMatch[1]) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  const ms = hours * 3_600_000 + minutes * 60_000;
  if (ms < MIN_AFK_MS || ms > MAX_AFK_MS) return null;
  return ms;
}

async function refreshAfkPanels(client, guildId) {
  pruneExpired(guildId);
  const settings = store.getGuild(guildId);
  const payload = panelPayload(settings);
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'afk')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(payload);
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель AFK:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function publishAfkPanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const payload = panelPayload(settings);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === 'afk' && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      store.rememberPanel(interaction.guildId, {
        key: 'afk',
        channelId: channel.id,
        messageId: message.id,
      });
      return { edited: true, message };
    } catch {
      // старое сообщение удалили — отправим новое
    }
  }

  const message = await channel.send(payload);
  store.rememberPanel(interaction.guildId, {
    key: 'afk',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

function joinModal() {
  return new ModalBuilder()
    .setCustomId('afk:modal')
    .setTitle('Уйти в AFK')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
          .setPlaceholder('Отойду на дела'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('Время')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setPlaceholder('15м или 1ч'),
      ),
    );
}

async function handleAfkButton(interaction) {
  const action = interaction.customId.split(':')[1];
  pruneExpired(interaction.guildId);
  const settings = store.getGuild(interaction.guildId);
  const current = (settings.afk?.entries || []).find((entry) => entry.userId === interaction.user.id);

  if (action === 'join') {
    return interaction.showModal(joinModal());
  }

  if (action === 'leave') {
    if (!current) {
      return interaction.reply({
        content: 'Вы не в AFK.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.afk.entries = guild.afk.entries.filter((entry) => entry.userId !== interaction.user.id);
    });
    await interaction.reply({
      content: 'Вы вышли с AFK.',
      flags: MessageFlags.Ephemeral,
    });
    await refreshAfkPanels(interaction.client, interaction.guildId);
    return;
  }

  if (action === 'list') {
    return interaction.reply({
      components: [buildAfkList(store.getGuild(interaction.guildId))],
      flags: v2Flags(true),
      allowedMentions: { parse: [] },
    });
  }
}

async function handleAfkModal(interaction) {
  const reason = truncate(interaction.fields.getTextInputValue('reason').trim(), 200);
  const durationMs = parseAfkDuration(interaction.fields.getTextInputValue('time'));

  if (!reason) {
    return interaction.reply({
      content: 'Укажите причину.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!durationMs) {
    return interaction.reply({
      content: 'Время пишите так: `15м` или `1ч`. Минимум 1м, максимум 24ч.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const now = Date.now();
  const durationLabel = formatAfkDuration(durationMs);
  store.updateGuild(interaction.guildId, (guild) => {
    guild.afk.entries = (guild.afk.entries || []).filter((entry) => entry.userId !== interaction.user.id);
    guild.afk.entries.push({
      userId: interaction.user.id,
      reason,
      durationLabel,
      startedAt: now,
      endsAt: now + durationMs,
    });
  });

  await interaction.reply({
    content: `Вы ушли в AFK на **${durationLabel}**. Причина: ${reason}`,
    flags: MessageFlags.Ephemeral,
  });
  await refreshAfkPanels(interaction.client, interaction.guildId);
}

async function releaseExpiredAfk(client) {
  for (const guildId of store.getGuildIds()) {
    if (pruneExpired(guildId)) {
      await refreshAfkPanels(client, guildId);
    }
  }
}

function setupAfk(client) {
  client.once(Events.ClientReady, () => {
    releaseExpiredAfk(client).catch(console.error);
    for (const guildId of store.getGuildIds()) {
      refreshAfkPanels(client, guildId).catch(console.error);
    }
    setInterval(() => releaseExpiredAfk(client).catch(console.error), 10_000);
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const settings = store.getGuild(member.guild.id);
    if (!(settings.afk?.entries || []).some((entry) => entry.userId === member.id)) return;
    store.updateGuild(member.guild.id, (guild) => {
      guild.afk.entries = guild.afk.entries.filter((entry) => entry.userId !== member.id);
    });
    await refreshAfkPanels(client, member.guild.id);
  });
}

module.exports = {
  publishAfkPanel,
  refreshAfkPanels,
  handleAfkButton,
  handleAfkModal,
  setupAfk,
  parseAfkDuration,
};
