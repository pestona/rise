const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const store = require('./store');
const { buildPositionsPanel } = require('./ui');
const { hasAccess, truncate } = require('./util');

function panelPayload(settings) {
  return {
    ...buildPositionsPanel(settings),
    allowedMentions: { parse: [] },
  };
}

function occupiedClaims(claims) {
  return Object.entries(claims || {})
    .filter(([, userId]) => userId)
    .sort((a, b) => Number(a[0]) - Number(b[0]));
}

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function occupantName(guild, userId) {
  const member = guild.members.cache.get(userId);
  return member?.displayName || member?.user?.username || userId;
}

async function refreshPositionPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'positions')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(panelPayload(settings));
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель позиций:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function freezePositionPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const payload = { ...panelPayload(settings), components: [] };

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'positions')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(payload);
    } catch (error) {
      if (error.code !== 10008) {
        console.warn('Не удалось заморозить панель позиций:', error.message);
      }
    }
  }

  store.setPanels(
    guildId,
    store.listPanels(guildId).filter((item) => item.key !== 'positions'),
  );
}

async function publishPositionsPanel(interaction, channel) {
  const message = await channel.send(panelPayload(store.getGuild(interaction.guildId)));
  store.rememberPanel(interaction.guildId, {
    key: 'positions',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function handlePickCommand(interaction) {
  const settings = store.getGuild(interaction.guildId);
  if (!hasAccess(interaction.member, settings, 'positionsCreate')) {
    return interaction.reply({
      content: 'У вас нет доступа к команде `/пик`.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const slotCount = interaction.options.getInteger('слоты', true);
  const image = interaction.options.getAttachment('фото', true);

  if (!image.contentType?.startsWith('image/') && !image.width) {
    return interaction.reply({
      content: 'В параметре «фото» нужно загрузить изображение или GIF.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await freezePositionPanels(interaction.client, interaction.guildId);
  store.updateGuild(interaction.guildId, (guild) => {
    guild.positions.slotCount = slotCount;
    guild.positions.imageUrl = image.url;
    guild.positions.claims = {};
  });

  await publishPositionsPanel(interaction, interaction.channel);
  await interaction.editReply(`Новая панель создана: **${slotCount}** позиций.`);
}

function denyModeration(interaction) {
  return interaction.reply({
    content: 'Модерировать пик могут только администраторы.',
    flags: MessageFlags.Ephemeral,
  });
}

function moderationListPayload(guild, notice = '') {
  const settings = store.getGuild(guild.id);
  const claims = settings.positions?.claims || {};
  const occupied = occupiedClaims(claims);
  const slotCount = settings.positions?.slotCount || 10;
  const list = occupied.length
    ? occupied.map(([number, userId]) => `**${number}.** <@${userId}>`).join('\n')
    : '_Никто не занял позицию._';
  const components = occupied.length
    ? chunk(occupied, 25).map((group, index) =>
        new ActionRowBuilder().setComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`pos:modpick:${index}`)
            .setPlaceholder('Кого модерировать')
            .addOptions(
              group.map(([number, userId]) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(truncate(`${number}. ${occupantName(guild, userId)}`, 100))
                  .setDescription(`ID ${userId}`)
                  .setValue(String(number)),
              ),
            ),
        ),
      )
    : [];

  return {
    content: truncate(
      `${notice ? `${notice}\n\n` : ''}## Модерация пика\nЗанято: **${occupied.length}/${slotCount}**\n\n${list}`,
      1900,
    ),
    components,
    allowedMentions: { parse: [] },
  };
}

function moderationPersonPayload(guild, number) {
  const settings = store.getGuild(guild.id);
  const claims = settings.positions?.claims || {};
  const userId = claims[number] || claims[String(number)];
  if (!userId) return moderationListPayload(guild, 'Эта позиция уже свободна.');

  const slotCount = settings.positions?.slotCount || 10;
  const targets = [];
  for (let slot = 1; slot <= slotCount; slot += 1) {
    if (slot === Number(number)) continue;
    targets.push({ slot, occupant: claims[slot] || claims[String(slot)] || null });
  }

  const rows = [
    new ActionRowBuilder().setComponents(
      new ButtonBuilder()
        .setCustomId(`pos:kick:${number}`)
        .setLabel('Выписать')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('pos:modback')
        .setLabel('Назад к списку')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  for (const [index, group] of chunk(targets, 25).entries()) {
    rows.push(
      new ActionRowBuilder().setComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`pos:move:${number}:${index}`)
          .setPlaceholder('Пересадить на другую позицию')
          .addOptions(
            group.map(({ slot, occupant }) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`Позиция ${slot}`)
                .setDescription(
                  truncate(occupant ? `Обмен с ${occupantName(guild, occupant)}` : 'Свободна', 100),
                )
                .setValue(String(slot))
                .setEmoji(occupant ? '🔄' : '🟢'),
            ),
          ),
      ),
    );
  }

  return {
    content:
      `## Позиция ${number}\nСейчас: <@${userId}>\n\n` +
      `Выписать человека или пересадить на другую позицию. Если место занято — игроки поменяются.`,
    components: rows,
    allowedMentions: { parse: [] },
  };
}

async function sendModerationView(interaction, payload) {
  const data = {
    ...payload,
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  if (interaction.isMessageComponent() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
    return interaction.update(payload);
  }
  return interaction.reply(data);
}

async function openPositionModeration(interaction, notice = '') {
  const settings = store.getGuild(interaction.guildId);
  if (!hasAccess(interaction.member, settings, 'positionModerate')) {
    return denyModeration(interaction);
  }
  return sendModerationView(interaction, moderationListPayload(interaction.guild, notice));
}

function kickClaim(guildId, number) {
  let kicked = null;
  store.updateGuild(guildId, (guild) => {
    kicked = guild.positions.claims[number] || guild.positions.claims[String(number)] || null;
    delete guild.positions.claims[number];
    delete guild.positions.claims[String(number)];
  });
  return kicked;
}

function moveClaim(guildId, from, to) {
  let result = null;
  store.updateGuild(guildId, (guild) => {
    const claims = guild.positions.claims;
    const fromUser = claims[from] || claims[String(from)];
    if (!fromUser) return;
    const toUser = claims[to] || claims[String(to)] || null;
    delete claims[from];
    delete claims[String(from)];
    if (toUser) {
      claims[from] = toUser;
      claims[to] = fromUser;
      result = { fromUser, toUser, swapped: true };
    } else {
      claims[to] = fromUser;
      result = { fromUser, toUser: null, swapped: false };
    }
  });
  return result;
}

async function handlePositionModeration(interaction, action, arg) {
  const settings = store.getGuild(interaction.guildId);
  if (!hasAccess(interaction.member, settings, 'positionModerate')) {
    return denyModeration(interaction);
  }

  if (action === 'mod' || action === 'modback') {
    return openPositionModeration(interaction);
  }

  if (action === 'modpick') {
    const number = Number(interaction.values[0]);
    return sendModerationView(interaction, moderationPersonPayload(interaction.guild, number));
  }

  if (action === 'kick') {
    const number = Number(arg);
    const kicked = kickClaim(interaction.guildId, number);
    await refreshPositionPanels(interaction.client, interaction.guildId);
    if (!kicked) {
      return openPositionModeration(interaction, 'Эта позиция уже была свободна.');
    }
    return openPositionModeration(
      interaction,
      `Выписали <@${kicked}> с позиции **${number}**.`,
    );
  }

  if (action === 'move') {
    const from = Number(arg);
    const to = Number(interaction.values[0]);
    const slotCount = store.getGuild(interaction.guildId).positions?.slotCount || 10;
    if (!Number.isInteger(to) || to < 1 || to > slotCount || to === from) {
      return sendModerationView(
        interaction,
        moderationPersonPayload(interaction.guild, from),
      );
    }
    const moved = moveClaim(interaction.guildId, from, to);
    await refreshPositionPanels(interaction.client, interaction.guildId);
    if (!moved) {
      return openPositionModeration(interaction, 'Этот человек уже не на выбранной позиции.');
    }
    const notice = moved.swapped
      ? `Обменяли позиции **${from}** и **${to}**: <@${moved.fromUser}> ↔ <@${moved.toUser}>.`
      : `Пересадили <@${moved.fromUser}> с позиции **${from}** на **${to}**.`;
    return openPositionModeration(interaction, notice);
  }

  return interaction.reply({
    content: 'Неизвестное действие модерации.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePositionButton(interaction) {
  const parts = interaction.customId.split(':');
  const rawAction = parts[1];
  if (['mod', 'modpick', 'kick', 'move', 'modback'].includes(rawAction)) {
    return handlePositionModeration(interaction, rawAction, parts[2]);
  }

  const action = rawAction === 'select' ? 'take' : rawAction;
  const rawNumber = rawAction === 'select' ? interaction.values[0] : parts[2];
  const settings = store.getGuild(interaction.guildId);
  const claims = settings.positions?.claims || {};

  if (action === 'leave') {
    const claimedEntry = Object.entries(claims).find(([, userId]) => userId === interaction.user.id);
    if (!claimedEntry) {
      return interaction.reply({
        content: 'Вы не занимали позицию.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      for (const [number, userId] of Object.entries(guild.positions.claims)) {
        if (userId === interaction.user.id) delete guild.positions.claims[number];
      }
    });
    await interaction.reply({
      content: `Вы освободили позицию **${claimedEntry[0]}**.`,
      flags: MessageFlags.Ephemeral,
    });
    await refreshPositionPanels(interaction.client, interaction.guildId);
    return;
  }

  const number = Number(rawNumber);
  const slotCount = settings.positions?.slotCount || 10;
  if (!Number.isInteger(number) || number < 1 || number > slotCount) {
    return interaction.reply({ content: 'Позиция не найдена.', flags: MessageFlags.Ephemeral });
  }
  const ownPosition = Object.entries(claims).find(([, userId]) => userId === interaction.user.id);
  if (claims[number] && claims[number] !== interaction.user.id) {
    return interaction.reply({
      content: `Позиция **${number}** уже занята.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (ownPosition?.[0] === String(number)) {
    return interaction.reply({
      content: `Вы уже занимаете позицию **${number}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  store.updateGuild(interaction.guildId, (guild) => {
    for (const [claimedNumber, userId] of Object.entries(guild.positions.claims)) {
      if (userId === interaction.user.id) delete guild.positions.claims[claimedNumber];
    }
    guild.positions.claims[number] = interaction.user.id;
  });
  await interaction.reply({
    content: ownPosition
      ? `Вы сменили позицию **${ownPosition[0]}** на **${number}**.`
      : `Вы заняли позицию **${number}**.`,
    flags: MessageFlags.Ephemeral,
  });
  await refreshPositionPanels(interaction.client, interaction.guildId);
}

module.exports = {
  refreshPositionPanels,
  publishPositionsPanel,
  handlePickCommand,
  handlePositionButton,
  openPositionModeration,
};
