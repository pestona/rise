const {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const store = require('./store');
const { buildArchivePanel, buildArchiveRoom, v2Flags } = require('./ui');
const { hasAccess, isAdmin, truncate } = require('./util');

function canManageArchive(member, settings) {
  if (isAdmin(member)) return true;
  if (hasAccess(member, settings, 'archiveManage')) return true;
  return (settings.archive?.staffRoleIds || []).some((roleId) => member.roles.cache.has(roleId));
}

function canCreateArchive(member, settings) {
  if (isAdmin(member)) return true;
  if (hasAccess(member, settings, 'archiveCreate')) return true;
  const roleIds = settings.archive?.createRoleIds || [];
  if (!roleIds.length) return true;
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function panelPayload(settings) {
  return {
    components: [buildArchivePanel(settings)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };
}

function roomPayload(settings, member, entry) {
  return {
    components: [buildArchiveRoom(settings, member, entry)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };
}

function sortRolesByPosition(guild, roleIds) {
  return [...(roleIds || [])].sort((left, right) => {
    const a = guild.roles.cache.get(left)?.position || 0;
    const b = guild.roles.cache.get(right)?.position || 0;
    return a - b;
  });
}

function currentOwnedRole(member, roleIds, guild) {
  const ordered = sortRolesByPosition(guild, roleIds);
  return [...ordered].reverse().find((roleId) => member.roles.cache.has(roleId)) || null;
}

function channelNameFor(member) {
  const raw = String(member.displayName || member.user?.username || 'user')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9а-яё\-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncate(`архив-${raw || member.user?.username || 'user'}`, 90);
}

function findEntry(settings, predicate) {
  return (settings.archive?.channels || []).find(predicate) || null;
}

async function refreshArchivePanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const payload = panelPayload(settings);
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'archive')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(payload);
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель архива:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function refreshArchiveRoom(client, guildId, entry) {
  if (!entry?.channelId || !entry?.messageId) return;
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(entry.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(entry.messageId).catch(() => null);
  const member = await guild.members.fetch(entry.userId).catch(() => null);
  if (!message) return;
  await message.edit(roomPayload(store.getGuild(guildId), member, entry)).catch(() => null);
}

async function publishArchivePanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const payload = panelPayload(settings);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === 'archive' && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      store.rememberPanel(interaction.guildId, {
        key: 'archive',
        channelId: channel.id,
        messageId: message.id,
      });
      return { edited: true, message };
    } catch {
      // старое сообщение удалили
    }
  }

  const message = await channel.send(payload);
  store.rememberPanel(interaction.guildId, {
    key: 'archive',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function createThreads(channel, names) {
  const threadIds = [];
  for (const name of names.slice(0, 5)) {
    const title = truncate(String(name || '').trim(), 100);
    if (!title) continue;
    const thread = await channel.threads
      .create({
        name: title,
        type: ChannelType.PublicThread,
        autoArchiveDuration: 10080,
        reason: 'Ветка архива',
      })
      .catch(() => null);
    if (thread) threadIds.push(thread.id);
  }
  return threadIds;
}

async function handleCreate(interaction) {
  const settings = store.getGuild(interaction.guildId);
  if (!canCreateArchive(interaction.member, settings)) {
    return interaction.reply({
      content: 'Вам нельзя создавать канал архива.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const categoryId = settings.archive?.categoryId;
  if (!categoryId) {
    return interaction.reply({
      content: 'Категория архива ещё не выбрана в `/panel` → Архив.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const existing = findEntry(settings, (item) => item.userId === interaction.user.id);
  if (existing) {
    const channel = await interaction.guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel) {
      return interaction.reply({
        content: `У вас уже есть канал архива: ${channel}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const staffRoleIds = settings.archive?.staffRoleIds || [];
  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.CreatePublicThreads,
      ],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    },
    ...staffRoleIds.map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    })),
  ];

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: channelNameFor(interaction.member),
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Архив ${interaction.member.displayName}`,
      permissionOverwrites: overwrites,
      reason: `Архив для ${interaction.user.tag}`,
    });
  } catch (error) {
    return interaction.editReply(
      `Не удалось создать канал. Проверьте права бота и категорию. ${error.message}`,
    );
  }

  const entry = {
    userId: interaction.user.id,
    channelId: channel.id,
    messageId: null,
    createdAt: Date.now(),
    threadIds: [],
  };

  const message = await channel.send(roomPayload(settings, interaction.member, entry));
  const threadIds = await createThreads(channel, settings.archive?.threadNames || []);
  entry.messageId = message.id;
  entry.threadIds = threadIds;

  store.updateGuild(interaction.guildId, (guild) => {
    guild.archive.channels = (guild.archive.channels || []).filter(
      (item) => item.userId !== interaction.user.id && item.channelId !== channel.id,
    );
    guild.archive.channels.push(entry);
  });

  return interaction.editReply(`Канал архива создан: ${channel}`);
}

async function applyRank(member, settings, direction) {
  const ordered = sortRolesByPosition(member.guild, settings.archive?.rankRoleIds || []);
  if (!ordered.length) return 'В `/panel` → Архив не выбраны роли рангов.';

  const current = currentOwnedRole(member, ordered, member.guild);
  const index = current ? ordered.indexOf(current) : -1;
  const nextId = direction === 'up' ? ordered[index + 1] || (current ? null : ordered[0]) : ordered[index - 1];

  if (direction === 'up' && current && !ordered[index + 1]) return 'Это уже максимальный ранг.';
  if (direction === 'down' && !current) return 'Ранга нет, понижать нечего.';
  if (direction === 'down' && index === 0) {
    await member.roles.remove(ordered).catch(() => null);
    return 'Ранг снят.';
  }
  if (!nextId) return 'Некуда менять ранг.';

  await member.roles.remove(ordered.filter((roleId) => roleId !== nextId)).catch(() => null);
  await member.roles.add(nextId).catch(() => null);
  return direction === 'up' ? 'Ранг повышен.' : 'Ранг понижен.';
}

async function applyTier(member, settings, value) {
  const tierIds = settings.archive?.tierRoleIds || [];
  if (!tierIds.length) return 'В `/panel` → Архив не выбраны роли тиров.';
  await member.roles.remove(tierIds).catch(() => null);
  if (value === 'off') return 'Тир снят.';
  if (!tierIds.includes(value)) return 'Такого тира нет.';
  await member.roles.add(value).catch(() => null);
  return 'Тир выдан.';
}

async function handleArchiveAction(interaction) {
  const [kind, action, userId] = interaction.customId.split(':');
  if (kind !== 'arch') return;
  const settings = store.getGuild(interaction.guildId);

  if (action === 'create') return handleCreate(interaction);

  const entry = findEntry(
    settings,
    (item) => item.channelId === interaction.channelId || item.userId === userId,
  );
  if (!entry) {
    return interaction.reply({
      content: 'Этот канал архива не найден в базе.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!canManageArchive(interaction.member, settings)) {
    return interaction.reply({
      content: 'Тиры и ранги могут менять только уполномоченные роли.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const choice = interaction.values?.[0];
  if (action === 'act' && choice === 'delete') {
    await interaction.reply({ content: 'Канал удаляю.', flags: MessageFlags.Ephemeral });
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.channels = (guild.archive.channels || []).filter((item) => item.userId !== entry.userId);
    });
    await interaction.channel.delete('Архив удалён').catch(() => null);
    return;
  }

  const member = await interaction.guild.members.fetch(entry.userId).catch(() => null);
  if (!member) {
    return interaction.reply({
      content: 'Участник больше не на сервере.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let result = 'Готово.';
  if (action === 'act' && choice === 'rankup') result = await applyRank(member, settings, 'up');
  if (action === 'act' && choice === 'rankdown') result = await applyRank(member, settings, 'down');
  if (action === 'tier') result = await applyTier(member, settings, choice);

  await refreshArchiveRoom(interaction.client, interaction.guildId, entry);
  return interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
}

function setupArchive(client) {
  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.guildId) return;
    const settings = store.getGuild(channel.guildId);
    if (!(settings.archive?.channels || []).some((item) => item.channelId === channel.id)) return;
    store.updateGuild(channel.guildId, (guild) => {
      guild.archive.channels = (guild.archive.channels || []).filter(
        (item) => item.channelId !== channel.id,
      );
    });
  });
}

module.exports = {
  publishArchivePanel,
  refreshArchivePanels,
  handleArchiveAction,
  setupArchive,
};
