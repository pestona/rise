const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const store = require('./store');
const { buildGatheringList, buildGatheringPanel } = require('./ui');
const { canReview, shortId, truncate } = require('./util');
const { recordGathering } = require('./activity');

const MAX_ROSTER = 50;

function panelPayload(settings) {
  return {
    ...buildGatheringPanel(settings),
    allowedMentions: { parse: [] },
  };
}

function listPayload(settings, closed = false) {
  return {
    ...buildGatheringList(settings, closed),
    allowedMentions: { parse: [] },
  };
}

function canManage(member, settings) {
  return canReview(member, settings);
}

function getActive(guildId) {
  return store.getGuild(guildId).gatherings?.active || null;
}

function occupantName(guild, userId) {
  const member = guild.members.cache.get(userId);
  return member?.displayName || member?.user?.username || userId;
}

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function whereIs(active, userId) {
  if (active.main?.includes(userId)) return 'main';
  if (active.bench?.includes(userId)) return 'bench';
  return null;
}

function removeFromRosters(active, userId) {
  active.main = (active.main || []).filter((id) => id !== userId);
  active.bench = (active.bench || []).filter((id) => id !== userId);
}

async function refreshGatheringPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'gatherings')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(panelPayload(settings));
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель сборов:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function refreshGatheringList(client, guildId, closed = false) {
  const settings = store.getGuild(guildId);
  const active = settings.gatherings?.active;
  if (!active?.channelId || !active?.messageId) return;
  try {
    const channel = await client.channels.fetch(active.channelId);
    const message = await channel.messages.fetch(active.messageId);
    await message.edit(listPayload(settings, closed));
  } catch (error) {
    if (error.code !== 10008) {
      console.warn('Не удалось обновить список сбора:', error.message);
    }
  }
}

async function publishGatheringPanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === 'gatherings' && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(panelPayload(settings));
      return { edited: true, message };
    } catch {
      // Сообщение удалено — создадим новое.
    }
  }

  const message = await channel.send(panelPayload(settings));
  store.rememberPanel(interaction.guildId, {
    key: 'gatherings',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function closeActiveGathering(client, guildId) {
  const active = getActive(guildId);
  if (!active) return false;
  await refreshGatheringList(client, guildId, true);
  recordGathering(guildId, active);
  store.updateGuild(guildId, (guild) => {
    guild.gatherings.active = null;
  });
  await refreshGatheringPanels(client, guildId);
  return true;
}

function parseGatheringTime(raw, now = new Date()) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Укажите время.' };

  const minutesOnly = text.match(/^(\d{1,4})$/);
  if (minutesOnly) {
    const mins = Number(minutesOnly[1]);
    if (mins < 1 || mins > 10080) {
      return { ok: false, error: 'Минуты: от 1 до 10080.' };
    }
    return { ok: true, at: new Date(now.getTime() + mins * 60 * 1000), input: text };
  }

  const withUnit = text.match(
    /^(\d{1,4})\s*(м|мин|минута|минуты|минут|ч|час|часа|часов|д|дн|день|дня|дней)$/i,
  );
  if (withUnit) {
    const amount = Number(withUnit[1]);
    const unit = withUnit[2].toLowerCase();
    const multiplier = unit.startsWith('ч') ? 60 : unit.startsWith('д') ? 1440 : 1;
    const mins = amount * multiplier;
    if (mins < 1 || mins > 10080) {
      return { ok: false, error: 'Слишком большое время. Максимум 7 дней.' };
    }
    return { ok: true, at: new Date(now.getTime() + mins * 60 * 1000), input: text };
  }

  let rest = text.replace(/\s+/g, ' ').trim();
  let dayOffset = 0;
  const lower = rest.toLowerCase();
  if (lower.startsWith('завтра')) {
    dayOffset = 1;
    rest = rest.slice(6).trim();
  } else if (lower.startsWith('сегодня')) {
    rest = rest.slice(7).trim();
  }

  const dateTime = rest.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?[ T]+(\d{1,2})[:.](\d{2})$/);
  if (dateTime) {
    const day = Number(dateTime[1]);
    const month = Number(dateTime[2]) - 1;
    let year = dateTime[3] ? Number(dateTime[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const hours = Number(dateTime[4]);
    const minutes = Number(dateTime[5]);
    if (month < 0 || month > 11 || day < 1 || day > 31 || hours > 23 || minutes > 59) {
      return { ok: false, error: 'Некорректная дата или время.' };
    }
    const at = new Date(year, month, day, hours, minutes, 0, 0);
    if (Number.isNaN(at.getTime())) return { ok: false, error: 'Некорректная дата.' };
    if (!dateTime[3] && at.getTime() <= now.getTime()) at.setFullYear(at.getFullYear() + 1);
    return { ok: true, at, input: text };
  }

  const timeOnly = rest.match(/^(\d{1,2})[:.](\d{2})$/);
  if (timeOnly) {
    const hours = Number(timeOnly[1]);
    const minutes = Number(timeOnly[2]);
    if (hours > 23 || minutes > 59) return { ok: false, error: 'Время: часы 0–23, минуты 0–59.' };
    const at = new Date(now);
    at.setSeconds(0, 0);
    at.setHours(hours, minutes, 0, 0);
    at.setDate(at.getDate() + dayOffset);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return { ok: true, at, input: text };
  }

  return {
    ok: false,
    error: 'Не понял время. Примеры: `15` (через 15 мин), `21:00`, `20.09 21:00`, `завтра 18:30`.',
  };
}

async function resolveListChannel(interaction) {
  const channel = interaction.channel;
  if (channel?.isTextBased() && channel.type !== ChannelType.GuildForum) return channel;
  return interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
}

function rosterLimit(active, list) {
  if (list === 'main') return active.maxMain || MAX_ROSTER;
  return MAX_ROSTER;
}

function addUser(guildId, userId, list) {
  let result = 'missing';
  store.updateGuild(guildId, (guild) => {
    const active = guild.gatherings.active;
    if (!active) return;
    const current = whereIs(active, userId);
    if (current === list) {
      result = 'already';
      return;
    }
    const target = list === 'bench' ? active.bench : active.main;
    if (target.length >= rosterLimit(active, list)) {
      result = 'full';
      return;
    }
    removeFromRosters(active, userId);
    if (list === 'bench') active.bench.push(userId);
    else active.main.push(userId);
    result = current ? 'moved' : 'ok';
  });
  return result;
}

function kickUser(guildId, userId) {
  let found = null;
  store.updateGuild(guildId, (guild) => {
    const active = guild.gatherings.active;
    if (!active) return;
    found = whereIs(active, userId);
    if (found) removeFromRosters(active, userId);
  });
  return found;
}

function denyManage(interaction) {
  return interaction.reply({
    content: 'Запускать и модерировать сборы могут администрация и персонал.',
    flags: MessageFlags.Ephemeral,
  });
}

function sendEphemeralView(interaction, payload) {
  const data = { ...payload, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  if (interaction.isMessageComponent() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
    return interaction.update(payload);
  }
  return interaction.reply(data);
}

function moderationHomePayload(guild, notice = '') {
  const active = store.getGuild(guild.id).gatherings?.active;
  if (!active) {
    return {
      content: 'Сейчас нет открытого сбора.',
      components: [],
    };
  }

  const entries = [
    ...(active.main || []).map((userId) => ({ userId, list: 'main', label: 'Основа' })),
    ...(active.bench || []).map((userId) => ({ userId, list: 'bench', label: 'Замена' })),
  ];
  const listText = entries.length
    ? [
        `**Основа (${active.main.length})**\n${
          active.main.map((id, index) => `${index + 1}. <@${id}>`).join('\n') || '_пусто_'
        }`,
        `**Замена (${active.bench.length})**\n${
          active.bench.map((id, index) => `${index + 1}. <@${id}>`).join('\n') || '_пусто_'
        }`,
      ].join('\n\n')
    : '_Список пуст._';

  const components = [];
  if (entries.length) {
    for (const [index, group] of chunk(entries, 25).entries()) {
      components.push(
        new ActionRowBuilder().setComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`gath:modpick:${index}`)
            .setPlaceholder('Кого модерировать')
            .addOptions(
              group.map((item) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(truncate(`${item.label}: ${occupantName(guild, item.userId)}`, 100))
                  .setDescription(item.userId)
                  .setValue(`${item.list}:${item.userId}`),
              ),
            ),
        ),
      );
    }
  }

  if (components.length < 5) {
    components.push(
      new ActionRowBuilder().setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('gath:add:main')
          .setPlaceholder('Записать в основу')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
  }
  if (components.length < 5) {
    components.push(
      new ActionRowBuilder().setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('gath:add:bench')
          .setPlaceholder('Записать в замену')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
  }

  return {
    content: truncate(
      `${notice ? `${notice}\n\n` : ''}## Модерация сбора · ${active.title}\n\n${listText}`,
      1900,
    ),
    components,
    allowedMentions: { parse: [] },
  };
}

function moderationPersonPayload(guild, list, userId) {
  const active = store.getGuild(guild.id).gatherings?.active;
  if (!active || !whereIs(active, userId)) {
    return moderationHomePayload(guild, 'Этого человека уже нет в списке.');
  }
  const place = list === 'bench' ? 'замене' : 'основе';
  return {
    content: `## <@${userId}>\nСейчас в **${place}**.`,
    components: [
      new ActionRowBuilder().setComponents(
        new ButtonBuilder()
          .setCustomId(`gath:kick:${userId}`)
          .setLabel('Выписать')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`gath:tomain:${userId}`)
          .setLabel('В основу')
          .setStyle(ButtonStyle.Success)
          .setDisabled(list === 'main'),
        new ButtonBuilder()
          .setCustomId(`gath:tobench:${userId}`)
          .setLabel('В замену')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(list === 'bench'),
        new ButtonBuilder()
          .setCustomId('gath:modback')
          .setLabel('Назад')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

async function openGatheringModeration(interaction, notice = '') {
  const settings = store.getGuild(interaction.guildId);
  if (!canManage(interaction.member, settings)) return denyManage(interaction);
  return sendEphemeralView(interaction, moderationHomePayload(interaction.guild, notice));
}

async function afterRosterChange(interaction) {
  await refreshGatheringList(interaction.client, interaction.guildId);
  await refreshGatheringPanels(interaction.client, interaction.guildId);
}

async function handleGatheringCommand(interaction) {
  const settings = store.getGuild(interaction.guildId);
  if (!canManage(interaction.member, settings)) return denyManage(interaction);

  const time = interaction.options.getString('время', true).trim();
  const content = interaction.options.getString('контент', true).trim();
  const maxMain = interaction.options.getInteger('участников', true);
  const pingRole = interaction.options.getRole('роль', true);
  const parsed = parseGatheringTime(time);

  if (!parsed.ok) {
    return interaction.reply({
      content: parsed.error,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!content) {
    return interaction.reply({
      content: 'Укажите контент.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const channel = await resolveListChannel(interaction);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) {
    return interaction.reply({
      content: 'Команду нужно писать в текстовом канале.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (getActive(interaction.guildId)) {
    await closeActiveGathering(interaction.client, interaction.guildId);
  }

  const gathering = {
    id: shortId(),
    title: content,
    time,
    timeAt: parsed.at.getTime(),
    content,
    maxMain,
    startedBy: interaction.user.id,
    startedAt: Date.now(),
    channelId: channel.id,
    messageId: null,
    pingRoleId: pingRole.id,
    main: [],
    bench: [],
  };

  store.updateGuild(interaction.guildId, (guild) => {
    guild.gatherings.active = gathering;
  });

  const payload = listPayload(store.getGuild(interaction.guildId));
  const message = await channel.send({
    content: `<@&${pingRole.id}>`,
    ...payload,
    allowedMentions: { roles: [pingRole.id] },
  });

  store.updateGuild(interaction.guildId, (guild) => {
    if (guild.gatherings.active?.id === gathering.id) {
      guild.gatherings.active.messageId = message.id;
    }
  });
  await refreshGatheringPanels(interaction.client, interaction.guildId);

  const unix = Math.floor(parsed.at.getTime() / 1000);
  return interaction.editReply(
    `Сбор открыт здесь, в ${channel}.\nВремя: <t:${unix}:F> · <t:${unix}:R>\nКонтент: **${content}** · В основу: **${maxMain}**.`,
  );
}

async function handleGatheringAction(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const arg = parts[2];
  const settings = store.getGuild(interaction.guildId);
  const active = settings.gatherings?.active;

  if (action === 'close') {
    if (!canManage(interaction.member, settings)) return denyManage(interaction);
    const closed = await closeActiveGathering(interaction.client, interaction.guildId);
    if (interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
      return interaction.update({
        content: closed ? 'Сбор завершён.' : 'Открытого сбора не было.',
        components: [],
      });
    }
    if (closed) {
      await refreshGatheringPanels(interaction.client, interaction.guildId);
      return interaction.reply({ content: 'Сбор завершён.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: 'Открытого сбора нет.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'mod' || action === 'modback') {
    return openGatheringModeration(interaction);
  }

  if (action === 'modpick') {
    if (!canManage(interaction.member, settings)) return denyManage(interaction);
    const [list, userId] = String(interaction.values[0] || '').split(':');
    return sendEphemeralView(interaction, moderationPersonPayload(interaction.guild, list, userId));
  }

  if (action === 'add') {
    if (!canManage(interaction.member, settings)) return denyManage(interaction);
    const userId = interaction.values[0];
    const list = arg === 'bench' ? 'bench' : 'main';
    if (!active) {
      return sendEphemeralView(interaction, { content: 'Сейчас нет открытого сбора.', components: [] });
    }
    const result = addUser(interaction.guildId, userId, list);
    await afterRosterChange(interaction);
    const place = list === 'bench' ? 'замену' : 'основу';
    const notice =
      result === 'full'
        ? `В ${place} уже ${MAX_ROSTER} человек.`
        : result === 'already'
          ? `<@${userId}> уже в этом списке.`
          : `Записали <@${userId}> в ${place}.`;
    return openGatheringModeration(interaction, notice);
  }

  if (action === 'kick') {
    if (!canManage(interaction.member, settings)) return denyManage(interaction);
    const kicked = kickUser(interaction.guildId, arg);
    await afterRosterChange(interaction);
    return openGatheringModeration(
      interaction,
      kicked ? `Выписали <@${arg}>.` : 'Этого человека уже не было в списке.',
    );
  }

  if (action === 'tomain' || action === 'tobench') {
    if (!canManage(interaction.member, settings)) return denyManage(interaction);
    const list = action === 'tobench' ? 'bench' : 'main';
    const result = addUser(interaction.guildId, arg, list);
    await afterRosterChange(interaction);
    const place = list === 'bench' ? 'замену' : 'основу';
    const notice =
      result === 'full'
        ? `В ${place} уже нет мест.`
        : result === 'already'
          ? `<@${arg}> уже там.`
          : `Пересадили <@${arg}> в ${place}.`;
    return openGatheringModeration(interaction, notice);
  }

  if (!active) {
    return interaction.reply({
      content: 'Сейчас нет открытого сбора.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'join') {
    const list = arg === 'bench' ? 'bench' : 'main';
    const result = addUser(interaction.guildId, interaction.user.id, list);
    const place = list === 'bench' ? 'замену' : 'основу';
    const limit = rosterLimit(active, list);
    if (result === 'full') {
      return interaction.reply({
        content:
          list === 'main'
            ? `Основа уже набрана (${limit}/${limit}). Можно записаться в замену.`
            : `В замене уже ${limit} человек.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (result === 'already') {
      return interaction.reply({
        content: `Вы уже записаны в ${place}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    await afterRosterChange(interaction);
    return interaction.reply({
      content:
        result === 'moved'
          ? `Вы перешли в ${place}.`
          : `Вы записались в ${place}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'leave') {
    const current = whereIs(active, interaction.user.id);
    if (!current) {
      return interaction.reply({
        content: 'Вас нет в списке.',
        flags: MessageFlags.Ephemeral,
      });
    }
    kickUser(interaction.guildId, interaction.user.id);
    await afterRosterChange(interaction);
    return interaction.reply({
      content: 'Вы выписались из списка.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: 'Неизвестное действие сбора.',
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  publishGatheringPanel,
  refreshGatheringPanels,
  closeActiveGathering,
  handleGatheringAction,
  handleGatheringCommand,
  openGatheringModeration,
};
