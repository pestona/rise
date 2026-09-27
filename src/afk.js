const {
  ActionRowBuilder,
  ChannelType,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const store = require('./store');
const { buildAfkList, buildAfkLog, buildAfkPanel, formatAfkDuration, v2Flags } = require('./ui');
const { truncate } = require('./util');

const MIN_AFK_MS = 60_000;
const MAX_AFK_MS = 7 * 24 * 60 * 60 * 1000;

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

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatUntilLabel(endsAt) {
  const at = new Date(endsAt);
  const now = new Date();
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getDate() === now.getDate() &&
    at.getMonth() === now.getMonth() &&
    at.getFullYear() === now.getFullYear();
  if (sameDay) return `до ${time}`;
  return `до ${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${time}`;
}

function withinAfkLimit(endsAt, now = Date.now()) {
  const ms = endsAt - now;
  return ms >= MIN_AFK_MS && ms <= MAX_AFK_MS;
}

function parseAfkTime(raw, now = new Date()) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const durationMs = parseAfkDuration(text);
  if (durationMs) {
    return { endsAt: now.getTime() + durationMs, label: formatAfkDuration(durationMs) };
  }

  const dateTime = text.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?[ T]+(\d{1,2})[:.](\d{2})$/);
  if (dateTime) {
    const day = Number(dateTime[1]);
    const month = Number(dateTime[2]) - 1;
    let year = dateTime[3] ? Number(dateTime[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const hours = Number(dateTime[4]);
    const minutes = Number(dateTime[5]);
    if (month < 0 || month > 11 || day < 1 || day > 31 || hours > 23 || minutes > 59) return null;
    const at = new Date(year, month, day, hours, minutes, 0, 0);
    if (Number.isNaN(at.getTime()) || !withinAfkLimit(at.getTime(), now.getTime())) return null;
    return { endsAt: at.getTime(), label: formatUntilLabel(at.getTime()) };
  }

  const timeOnly = text.match(/^(\d{1,2})[:.](\d{2})$/);
  if (timeOnly) {
    const hours = Number(timeOnly[1]);
    const minutes = Number(timeOnly[2]);
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now);
    at.setSeconds(0, 0);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    if (!withinAfkLimit(at.getTime(), now.getTime())) return null;
    return { endsAt: at.getTime(), label: formatUntilLabel(at.getTime()) };
  }

  return null;
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

async function sendAfkLog(client, guildId, entry) {
  const channelId = store.getGuild(guildId).afk?.logChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return;
  await channel
    .send({
      components: [buildAfkLog(entry)],
      flags: v2Flags(false),
      allowedMentions: { parse: [] },
    })
    .catch((error) => console.warn('Не удалось отправить лог AFK:', error.message));
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

function resolveKind(value) {
  return value === 'vacation' ? 'vacation' : 'afk';
}

function kindLabel(kind) {
  return kind === 'vacation' ? 'отпуск' : 'AFK';
}

function joinModal(kind) {
  const resolved = resolveKind(kind);
  return new ModalBuilder()
    .setCustomId(`afk:modal:${resolved}`)
    .setTitle(resolved === 'vacation' ? 'Уйти в отпуск' : 'Уйти в AFK')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
          .setPlaceholder(resolved === 'vacation' ? 'Отпуск / поездка' : 'Отойду на дела'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('На сколько или до которого')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setPlaceholder('15м, 23:00 или 23.09 23:00'),
      ),
    );
}

async function handleAfkButton(interaction) {
  const [, action, kind] = interaction.customId.split(':');
  pruneExpired(interaction.guildId);
  const settings = store.getGuild(interaction.guildId);
  const current = (settings.afk?.entries || []).find((entry) => entry.userId === interaction.user.id);

  if (action === 'join') {
    return interaction.showModal(joinModal(kind));
  }

  if (action === 'leave') {
    if (!current) {
      return interaction.reply({
        content: 'Вы не в AFK и не в отпуске.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.afk.entries = guild.afk.entries.filter((entry) => entry.userId !== interaction.user.id);
    });
    await interaction.reply({
      content: current.kind === 'vacation' ? 'Вы вышли из отпуска.' : 'Вы вышли с AFK.',
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
  const kind = resolveKind(interaction.customId.split(':')[2]);
  const reason = truncate(interaction.fields.getTextInputValue('reason').trim(), 200);
  const parsed = parseAfkTime(interaction.fields.getTextInputValue('time'));

  if (!reason) {
    return interaction.reply({
      content: 'Укажите причину.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!parsed) {
    return interaction.reply({
      content: 'Время пишите так: `15м`, `1ч`, `23:00` или `23.09 23:00`. Минимум 1м, максимум 7 дней, и только будущее время.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const now = Date.now();
  const entry = {
    userId: interaction.user.id,
    kind,
    reason,
    durationLabel: parsed.label,
    startedAt: now,
    endsAt: parsed.endsAt,
  };
  store.updateGuild(interaction.guildId, (guild) => {
    guild.afk.entries = (guild.afk.entries || []).filter((item) => item.userId !== interaction.user.id);
    guild.afk.entries.push(entry);
  });

  await interaction.reply({
    content: `Вы ушли в ${kindLabel(kind)} **${parsed.label}**. Причина: ${reason}`,
    flags: MessageFlags.Ephemeral,
  });
  await sendAfkLog(interaction.client, interaction.guildId, entry);
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
  parseAfkTime,
};
