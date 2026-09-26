const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const store = require('./store');
const {
  ACCESS_ACTIONS,
  isAdmin,
  isBotAdminId,
  isType,
  hasAccess,
  isHttpUrl,
  parseBool,
  parseStyle,
  parseUserIds,
  hidden,
  safeReply,
  shortId,
  truncate,
} = require('./util');
const {
  v2Flags,
  buildAdminHub,
  buildSummary,
  buildPanelsTab,
  buildLogsTab,
  buildAutoparkTab,
  buildGatheringsTab,
  buildActivityTab,
  buildActivityUserTab,
  buildAccessTab,
  buildSecurityTab,
  buildTicketTab,
  buildTypePage,
  buildDeleteQuestionMenu,
  buildArchiveTab,
} = require('./ui');
const { publishPanel, refreshAllPanels } = require('./tickets');
const { publishAutoparkPanel, refreshAutoparkPanels } = require('./autopark');
const { publishAfkPanel } = require('./afk');
const { publishArchivePanel, refreshArchivePanels } = require('./archive');
const { closeActiveGathering, refreshGatheringPanels, ensureGatheringThread } = require('./gatherings');
const { showVzpDatePicker, handleVzpDatePick, handleVzpEventPick } = require('./vzpStats');
const { createBackup, restoreBackup } = require('./security');
const { getActivityStats } = require('./activity');

function deny(interaction) {
  return interaction.reply(
    hidden({
      content: 'У вас нет доступа к этому разделу.',
    }),
  );
}

function getManagerIds(guildId) {
  const ids = store.getGuild(guildId).security?.managerUserIds;
  return Array.isArray(ids) ? ids : [];
}

function isGuildOwnerOrBotAdmin(interaction) {
  return interaction.user.id === interaction.guild.ownerId || isBotAdminId(interaction.user.id);
}

function isSecurityManager(interaction) {
  return isGuildOwnerOrBotAdmin(interaction) || getManagerIds(interaction.guildId).includes(interaction.user.id);
}

function isSecurityOnlyUser(interaction) {
  const settings = store.getGuild(interaction.guildId);
  return (
    !hasAccess(interaction.member, settings, 'settingsManage') &&
    isSecurityManager(interaction)
  );
}

function ensureAdmin(interaction) {
  if (!hasAccess(interaction.member, store.getGuild(interaction.guildId), 'settingsManage')) {
    deny(interaction);
    return false;
  }
  return true;
}

function ensurePanelAccess(interaction) {
  const settings = store.getGuild(interaction.guildId);
  if (
    hasAccess(interaction.member, settings, 'settingsManage') ||
    hasAccess(interaction.member, settings, 'panelsPublish') ||
    isSecurityManager(interaction)
  ) {
    return true;
  }
  deny(interaction);
  return false;
}

function denySecurityOnly(interaction) {
  return interaction.reply({
    content: 'Вам доступен только раздел защиты.',
    flags: MessageFlags.Ephemeral,
  });
}

function ensureOwner(interaction) {
  if (isGuildOwnerOrBotAdmin(interaction)) return true;
  interaction
    .reply({
      content: 'Назначать модераторов защиты может только владелец сервера и главный модератор бота.',
      flags: MessageFlags.Ephemeral,
    })
    .catch(console.error);
  return false;
}

function ensureSecurityAccess(interaction) {
  if (isSecurityManager(interaction)) return true;
  interaction
    .reply({
      content:
        'Настройки защиты доступны владельцу сервера, главному модератору бота и назначенным модераторам защиты.',
      flags: MessageFlags.Ephemeral,
    })
    .catch(console.error);
  return false;
}

function mergeManagerIds(interaction, incomingIds) {
  const existing = getManagerIds(interaction.guildId);
  const skip = new Set([
    interaction.guild.ownerId,
    interaction.client.user.id,
    ...existing,
  ]);
  const next = [...existing];
  const added = [];
  for (const id of incomingIds) {
    if (!id || skip.has(id) || isBotAdminId(id)) continue;
    if (next.length >= 25) break;
    skip.add(id);
    next.push(id);
    added.push(id);
  }
  return { next, added };
}

function panelIsEphemeral(interaction) {
  return Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
}

async function refreshStoredSecurityPanel(interaction) {
  const guild = store.getGuild(interaction.guildId);
  const payload = {
    components: [
      buildSecurityTab(guild, Boolean(store.getBackup(interaction.guildId)), { securityOnly: false }),
    ],
    flags: v2Flags(false),
  };
  const panel = guild.adminPanel;
  if (!panel?.channelId || !panel?.messageId) return;
  try {
    const channel = await interaction.client.channels.fetch(panel.channelId);
    const message = await channel.messages.fetch(panel.messageId);
    await message.edit(payload);
  } catch {
    // панель уже недоступна
  }
}

function adminPayload(interaction, page) {
  const guild = store.getGuild(interaction.guildId);
  const botName = (interaction.client.user?.username || interaction.guild?.name || 'RISE')
    .replace(/\s*bot$/i, '')
    .trim() || 'RISE';
  const ephemeralPanel =
    panelIsEphemeral(interaction) || (!interaction.message && isSecurityOnlyUser(interaction));
  const securityOnlyView = isSecurityOnlyUser(interaction) && ephemeralPanel;
  let container;
  if (page === 'vzp' || page === 'rp') container = buildTypePage(guild, page);
  else if (page === 'ticket') container = buildTicketTab(guild);
  else if (page === 'panels') container = buildPanelsTab(guild);
  else if (page === 'logs') container = buildLogsTab(guild);
  else if (page === 'autopark') container = buildAutoparkTab(guild);
  else if (page === 'gatherings') container = buildGatheringsTab(guild);
  else if (page === 'archive') container = buildArchiveTab(guild);
  else if (page === 'access') container = buildAccessTab(guild);
  else if (page.startsWith('activity')) {
    const period = page.split(':')[1] || 'week';
    container = buildActivityTab(getActivityStats(interaction.guildId, period), period);
  }
  else if (page === 'security') {
    container = buildSecurityTab(guild, Boolean(store.getBackup(interaction.guildId)), {
      securityOnly: securityOnlyView,
    });
  } else if (page === 'summary') container = buildSummary(guild);
  else container = buildAdminHub(guild, botName);
  return {
    components: [container],
    flags: v2Flags(ephemeralPanel),
  };
}

async function showAdmin(interaction, page = 'hub') {
  const payload = adminPayload(interaction, page);

  try {
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isMessageComponent()) {
        return await interaction.update(payload);
      }
      if (interaction.isModalSubmit()) {
        await interaction.deferUpdate();
        return await interaction.editReply(payload);
      }
      return await interaction.reply(payload);
    }
    return await interaction.editReply(payload);
  } catch (error) {
    console.warn('Не удалось обновить панель настроек:', error.message);
    try {
      if (interaction.message) {
        return await interaction.message.edit(payload);
      }
    } catch (editError) {
      console.warn('Не удалось отредактировать админ-панель:', editError.message);
    }
    return null;
  }
}

function emptyActivity(userId) {
  return {
    userId,
    messages: 0,
    voiceMs: 0,
    gatheringsMain: 0,
    gatheringsBench: 0,
  };
}

function activityForUser(guildId, userId, period) {
  return (
    getActivityStats(guildId, period).find((item) => item.userId === userId) ||
    emptyActivity(userId)
  );
}

async function showRoleActivity(interaction, roleId, period = 'week') {
  await interaction.deferUpdate();
  await interaction.guild.members.fetch().catch(() => null);
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return showAdmin(interaction, 'activity:week');

  const memberIds = new Set(role.members.keys());
  const stats = getActivityStats(interaction.guildId, period).filter((item) =>
    memberIds.has(item.userId),
  );
  return interaction.editReply({
    components: [
      buildActivityTab(stats, period, {
        roleId,
        title: `Активность роли <@&${roleId}>`,
      }),
    ],
  });
}

async function handlePanelCommand(interaction) {
  if (!ensurePanelAccess(interaction)) return;

  if (isSecurityOnlyUser(interaction)) {
    return interaction.reply(adminPayload(interaction, 'security'));
  }

  const guild = store.getGuild(interaction.guildId);
  if (
    !hasAccess(interaction.member, guild, 'settingsManage') &&
    hasAccess(interaction.member, guild, 'panelsPublish')
  ) {
    return interaction.reply({
      ...adminPayload(interaction, 'panels'),
      flags: v2Flags(true),
    });
  }
  if (guild.adminPanel?.channelId && guild.adminPanel?.messageId) {
    try {
      const channel = await interaction.client.channels.fetch(guild.adminPanel.channelId);
      const old = await channel.messages.fetch(guild.adminPanel.messageId);
      if (old.deletable) await old.delete();
    } catch {
      // старое сообщение уже нет
    }
  }

  const payload = adminPayload(interaction, 'hub');
  await interaction.reply(payload);
  const sent = await interaction.fetchReply();
  store.updateGuild(interaction.guildId, (settings) => {
    settings.adminPanel = { channelId: sent.channelId, messageId: sent.id };
  });
}

async function checkAllSettings(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = store.getGuild(interaction.guildId);
  const errors = [];
  const warnings = [];
  const ok = [];

  const channel = async (id) =>
    id ? interaction.guild.channels.fetch(id).catch(() => null) : null;
  const role = async (id) =>
    id ? interaction.guild.roles.fetch(id).catch(() => null) : null;
  const canWrite = (target, extra = []) =>
    target?.permissionsFor(interaction.guild.members.me)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      ...extra,
    ]);

  const botPermissions = [
    ['управлять каналами', PermissionFlagsBits.ManageChannels],
    ['управлять ролями', PermissionFlagsBits.ManageRoles],
    ['просматривать журнал аудита', PermissionFlagsBits.ViewAuditLog],
    ['перемещать участников', PermissionFlagsBits.MoveMembers],
    ['исключать участников', PermissionFlagsBits.KickMembers],
    ['выдавать тайм-аут', PermissionFlagsBits.ModerateMembers],
  ];
  const missingPermissions = botPermissions
    .filter(([, permission]) => !interaction.guild.members.me?.permissions.has(permission))
    .map(([name]) => name);
  if (missingPermissions.length) {
    errors.push(`Права бота: нет прав — ${missingPermissions.join(', ')}`);
  } else {
    ok.push('Основные права бота');
  }

  const staffRoles = await Promise.all((settings.staffRoleIds || []).map(role));
  const validStaffRoles = staffRoles.filter(Boolean);
  if (validStaffRoles.length) ok.push(`Роли персонала (${validStaffRoles.length})`);
  else warnings.push('Роли персонала не выбраны или удалены');
  if (validStaffRoles.length !== staffRoles.length) {
    warnings.push('Некоторые роли персонала удалены или недоступны');
  }

  for (const key of ['vzp', 'rp']) {
    const type = settings.types[key];
    if (!type.enabled) continue;
    const name = type.label || key.toUpperCase();
    const review = await channel(type.reviewChannelId);
    const category = await channel(type.acceptedChannelId);
    const forum = await channel(type.resultForumId);
    const ticketLog = await channel(type.logChannelId);
    const resultRole = await role(type.roleId);
    const issues = [];

    if (!review?.isTextBased() || review.type === ChannelType.GuildForum || !canWrite(review)) {
      issues.push('канал проверки');
    }
    if (
      category?.type !== ChannelType.GuildCategory ||
      !category.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.ManageChannels)
    ) {
      issues.push('категория обзвона');
    }
    if (
      forum?.type !== ChannelType.GuildForum ||
      !canWrite(forum, [PermissionFlagsBits.CreatePublicThreads])
    ) {
      issues.push('форум архива');
    }
    if (
      !ticketLog?.isTextBased() ||
      ticketLog.type === ChannelType.GuildForum ||
      !canWrite(ticketLog)
    ) {
      issues.push('канал логов');
    }
    if (!resultRole || !resultRole.editable) issues.push('выдаваемая роль');
    if (!type.questions?.length || type.questions.length > 5) issues.push('вопросы (нужно 1–5)');

    if (issues.length) errors.push(`${name}: проверьте ${issues.join(', ')}`);
    else ok.push(`Тикеты ${name}`);
  }

  const leaveLog = await channel(settings.logs?.leaveChannelId);
  const moderationLog = await channel(settings.logs?.moderationChannelId);
  if (leaveLog?.isTextBased() && leaveLog.type !== ChannelType.GuildForum && canWrite(leaveLog)) {
    ok.push('Логи выходов');
  } else {
    warnings.push('Канал логов выходов не настроен');
  }
  if (
    moderationLog?.isTextBased() &&
    moderationLog.type !== ChannelType.GuildForum &&
    canWrite(moderationLog)
  ) {
    ok.push('Логи киков и банов');
  } else {
    warnings.push('Канал логов киков и банов не настроен');
  }

  const missingWatchedRoles = [];
  for (const roleId of settings.logs?.watchedRoleIds || []) {
    if (!(await role(roleId))) missingWatchedRoles.push(roleId);
  }
  if (missingWatchedRoles.length) {
    errors.push(`Удалённые роли в логах выходов: ${missingWatchedRoles.length}`);
  }

  const missingVehicleRoles = [];
  for (const vehicle of settings.autopark?.vehicles || []) {
    for (const roleId of vehicle.roleIds || []) {
      if (!(await role(roleId))) missingVehicleRoles.push(`${vehicle.name}: ${roleId}`);
    }
  }
  if (missingVehicleRoles.length) {
    errors.push(`Автопарк — удалённые роли: ${missingVehicleRoles.join(', ')}`);
  } else if (settings.autopark?.vehicles?.length) {
    ok.push(`Автопарк (${settings.autopark.vehicles.length} машин)`);
  } else {
    warnings.push('В автопарке нет машин');
  }

  let validPanels = 0;
  const deadPanels = [];
  for (const panel of settings.panels || []) {
    const panelChannel = await channel(panel.channelId);
    const message = panelChannel?.isTextBased()
      ? await panelChannel.messages.fetch(panel.messageId).catch(() => null)
      : null;
    if (message) validPanels += 1;
    else deadPanels.push(panel.key);
  }
  if (validPanels) ok.push(`Опубликованные панели (${validPanels})`);
  if (deadPanels.length) errors.push(`Недоступные панели: ${deadPanels.join(', ')}`);
  if (!settings.panels?.length) warnings.push('Нет опубликованных панелей');

  if (settings.security?.enabled) {
    const securityLog = await channel(settings.security.logChannelId);
    if (
      securityLog?.isTextBased() &&
      securityLog.type !== ChannelType.GuildForum &&
      canWrite(securityLog)
    ) {
      ok.push('Anti-Nuke и канал тревог');
    } else {
      errors.push('Anti-Nuke включён, но канал тревог недоступен или бот не может писать');
    }
    if (store.getBackup(interaction.guildId)) ok.push('Резервная копия сервера');
    else warnings.push('Резервная копия сервера не создана');

    const invalidTrustedRoles = [];
    for (const roleId of settings.security.trustedRoleIds || []) {
      if (!(await role(roleId))) invalidTrustedRoles.push(roleId);
    }
    if (invalidTrustedRoles.length) {
      warnings.push(`В белом списке есть удалённые роли: ${invalidTrustedRoles.length}`);
    }
    if (
      settings.security.actionLimit < 1 ||
      settings.security.actionLimit > 10 ||
      settings.security.windowSeconds < 3 ||
      settings.security.windowSeconds > 60
    ) {
      errors.push('Некорректный лимит Anti-Nuke');
    }
    const botPosition = interaction.guild.members.me?.roles.highest.position || 0;
    const unreachableDangerousRoles = interaction.guild.roles.cache.filter(
      (item) =>
        !item.managed &&
        item.id !== interaction.guild.id &&
        item.position >= botPosition &&
        (item.permissions.has(PermissionFlagsBits.Administrator) ||
          item.permissions.has(PermissionFlagsBits.ManageGuild)),
    );
    if (unreachableDangerousRoles.size) {
      warnings.push(
        `Бот не сможет снять ${unreachableDangerousRoles.size} опасных ролей выше своей роли`,
      );
    }
  } else {
    warnings.push('Anti-Nuke выключен');
  }

  const report =
    `## Проверка настроек\n` +
    (errors.length ? `\n❌ **Ошибки**\n${errors.map((item) => `• ${item}`).join('\n')}\n` : '') +
    (warnings.length
      ? `\n⚠️ **Предупреждения**\n${warnings.map((item) => `• ${item}`).join('\n')}\n`
      : '') +
    `\n✅ **Исправно**\n${ok.length ? ok.map((item) => `• ${item}`).join('\n') : '• —'}\n\n` +
    `Итог: **${errors.length} ошибок**, **${warnings.length} предупреждений**.`;

  return interaction.editReply({ content: truncate(report, 1950) });
}

function bannerModal(current) {
  const urlInput = new TextInputBuilder()
    .setCustomId('url')
    .setLabel('Ссылка на GIF / картинку')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(400)
    .setPlaceholder('https://...gif  — пусто = убрать');
  if (current) urlInput.setValue(truncate(current, 400));

  return new ModalBuilder()
    .setCustomId('admin:banner:modal')
    .setTitle('GIF панели')
    .addComponents(new ActionRowBuilder().addComponents(urlInput));
}

function textModal(guild) {
  return new ModalBuilder()
    .setCustomId('admin:text:modal')
    .setTitle('Текст панели')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Заголовок')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120)
          .setValue(truncate(guild.panelTitle, 120)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Описание (плейсхолдер {cooldown})')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800)
          .setValue(truncate(guild.panelDescription, 1800)),
      ),
    );
}

function archivePublicModal(archive) {
  return new ModalBuilder()
    .setCustomId('admin:archpub:modal')
    .setTitle('Текст панели архива')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Заголовок')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(truncate(archive.publicTitle || 'Создать канал архива', 80)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Описание')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800)
          .setValue(truncate(archive.publicDescription || '', 1800)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button')
          .setLabel('Текст кнопки')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(truncate(archive.publicButton || 'Создать канал', 80)),
      ),
    );
}

function archiveRoomModal(archive) {
  return new ModalBuilder()
    .setCustomId('admin:archroom:modal')
    .setTitle('Текст личного канала')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Заголовок')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(truncate(archive.roomTitle || 'Личный канал архива', 80)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Описание')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800)
          .setValue(truncate(archive.roomDescription || '', 1800)),
      ),
    );
}

function archiveThreadsModal(archive) {
  return new ModalBuilder()
    .setCustomId('admin:archthreads:modal')
    .setTitle('Названия веток')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('names')
          .setLabel('По одному названию на строку')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400)
          .setValue(truncate((archive.threadNames || []).join('\n'), 400)),
      ),
    );
}

function cooldownModal(days) {
  return new ModalBuilder()
    .setCustomId('admin:cooldown:modal')
    .setTitle('Кулдаун после отказа')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('days')
          .setLabel('Дней до повторной заявки')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setValue(String(days)),
      ),
    );
}

function renameModal(typeKey, label) {
  return new ModalBuilder()
    .setCustomId(`admin:rename:modal:${typeKey}`)
    .setTitle('Название типа заявки')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Как отображать тип')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setValue(truncate(label, 20)),
      ),
    );
}

function questionModal(typeKey) {
  return new ModalBuilder()
    .setCustomId(`admin:qadd:modal:${typeKey}`)
    .setTitle('Новый вопрос')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Текст вопроса')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(45)
          .setPlaceholder('Например: Ваш игровой ник'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('style')
          .setLabel('Тип: короткий или абзац')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setValue('короткий'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('required')
          .setLabel('Обязательный? да / нет')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(5)
          .setValue('да'),
      ),
    );
}

function vehicleModal() {
  return new ModalBuilder()
    .setCustomId('admin:caradd:modal')
    .setTitle('Добавить машину')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Название и модель')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setPlaceholder('BMW M5 F90'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('plate')
          .setLabel('Госномер')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setPlaceholder('A001AA'),
      ),
    );
}

function vehicleTimeModal(durationMinutes) {
  return new ModalBuilder()
    .setCustomId('admin:cartime:modal')
    .setTitle('Общее время аренды')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('minutes')
          .setLabel('На сколько минут выдаётся машина')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(5)
          .setValue(String(durationMinutes || 60)),
      ),
    );
}

function gatheringPresetModal() {
  return new ModalBuilder()
    .setCustomId('admin:gathadd:modal')
    .setTitle('Тип сбора')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Название')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40)
          .setPlaceholder('МП, Контракт, Семейный сбор'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Короткое описание')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setPlaceholder('Список на мероприятие'),
      ),
    );
}

function securityManagerModal() {
  return new ModalBuilder()
    .setCustomId('admin:secmanager:modal')
    .setTitle('Модераторы защиты')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ids')
          .setLabel('ID пользователей')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
          .setPlaceholder('Можно несколько ID через пробел, запятую или с новой строки'),
      ),
    );
}

async function buildRemoveManagerMenu(guild, ids) {
  const options = [];
  for (const id of ids.slice(0, 25)) {
    const member = guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null));
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(truncate(member?.user?.tag || id, 100))
        .setDescription(id)
        .setValue(id),
    );
  }
  return new ActionRowBuilder().setComponents(
    new StringSelectMenuBuilder()
      .setCustomId('admin:security:delpick')
      .setPlaceholder('Кого убрать из модераторов')
      .setMinValues(1)
      .setMaxValues(Math.min(25, options.length))
      .addOptions(options),
  );
}

function securityLimitModal(security) {
  return new ModalBuilder()
    .setCustomId('admin:securitylimit:modal')
    .setTitle('Лимит Anti-Nuke')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('actions')
          .setLabel('Действий до срабатывания (1–10)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setValue(String(security.actionLimit || 3)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('seconds')
          .setLabel('Период в секундах (3–60)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setValue(String(security.windowSeconds || 10)),
      ),
    );
}

async function moveEveryoneToAdmin(interaction) {
  const target = interaction.member.voice?.channel;
  if (!target) {
    return interaction.reply({
      content: 'Сначала зайдите в голосовой канал.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (interaction.guild.afkChannelId === target.id) {
    return interaction.reply({
      content: 'Нельзя собирать участников в AFK-канале.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.MoveMembers)) {
    return interaction.reply({
      content: 'У бота нет права «Перемещать участников».',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let moved = 0;
  let skippedAfk = 0;
  let skippedAccess = 0;
  let failed = 0;
  const states = [...interaction.guild.voiceStates.cache.values()];

  for (const state of states) {
    const member = state.member;
    if (!member || member.user.bot || !state.channelId || state.channelId === target.id) continue;
    if (state.channelId === interaction.guild.afkChannelId) {
      skippedAfk += 1;
      continue;
    }

    const permissions = target.permissionsFor(member);
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.Connect)
    ) {
      skippedAccess += 1;
      continue;
    }

    try {
      await member.voice.setChannel(
        target,
        `Сбор в голосовой канал по запросу ${interaction.user.tag}`,
      );
      moved += 1;
    } catch {
      failed += 1;
    }
  }

  return interaction.editReply({
    content:
      `Перемещено в ${target}: **${moved}**.\n` +
      `Пропущено из AFK: **${skippedAfk}** · без доступа: **${skippedAccess}**` +
      (failed ? ` · ошибок: **${failed}**` : ''),
  });
}

async function handleAdminButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const arg = parts[2];
  const securityOnly = isSecurityOnlyUser(interaction);
  const securityAction = action === 'security' || action === 'securityrestore';
  const securityTab = action === 'tab' && arg === 'security';
  const settings = store.getGuild(interaction.guildId);
  const settingsAccess = hasAccess(interaction.member, settings, 'settingsManage');
  const publishAccess = hasAccess(interaction.member, settings, 'panelsPublish');

  if (securityOnly) {
    if (!securityAction && !securityTab) return denySecurityOnly(interaction);
  } else if (action === 'tab' && arg === 'access') {
    if (!isAdmin(interaction.member)) return deny(interaction);
  } else if (!settingsAccess) {
    if (publishAccess && action === 'tab' && arg === 'panels') {
      return showAdmin(interaction, 'panels');
    }
    if (publishAccess && (action === 'hub' || action === 'home')) {
      return showAdmin(interaction, 'panels');
    }
    return deny(interaction);
  }

  if (action === 'check') return checkAllSettings(interaction);
  if (action === 'moveall') return moveEveryoneToAdmin(interaction);
  if (action === 'tab' && arg === 'panels') return showAdmin(interaction, 'panels');
  if (action === 'tab' && arg === 'ticket') return showAdmin(interaction, 'ticket');
  if (action === 'tab' && arg === 'logs') return showAdmin(interaction, 'logs');
  if (action === 'tab' && arg === 'autopark') return showAdmin(interaction, 'autopark');
  if (action === 'tab' && arg === 'summary') return showAdmin(interaction, 'summary');
  if (action === 'tab' && arg === 'gatherings') return showAdmin(interaction, 'gatherings');
  if (action === 'tab' && arg === 'archive') return showAdmin(interaction, 'archive');
  if (action === 'tab' && arg === 'activity') return showAdmin(interaction, 'activity:week');
  if (action === 'tab' && arg === 'access') return showAdmin(interaction, 'access');
  if (action === 'tab' && arg === 'security') return showAdmin(interaction, 'security');
  if (action === 'activity' && ['day', 'week', 'month', 'all'].includes(arg)) {
    return showAdmin(interaction, `activity:${arg}`);
  }
  if (action === 'activityrole' && ['day', 'week', 'month', 'all'].includes(arg)) {
    return showRoleActivity(interaction, parts[3], arg);
  }
  if (action === 'hub' || action === 'home') return showAdmin(interaction, 'hub');
  if (action === 'page' && isType(arg)) return showAdmin(interaction, arg);

  if (action === 'security') {
    if (arg === 'addmanager') {
      if (!ensureOwner(interaction)) return;
      return interaction.reply({
        content:
          'Добавьте модераторов защиты: выберите участников сервера или введите Discord ID вручную.',
        components: [
          new ActionRowBuilder().setComponents(
            new UserSelectMenuBuilder()
              .setCustomId('admin:security:managers')
              .setPlaceholder('Выберите участников сервера')
              .setMinValues(1)
              .setMaxValues(25),
          ),
          new ActionRowBuilder().setComponents(
            new ButtonBuilder()
              .setCustomId('admin:security:addids')
              .setLabel('Ввести ID вручную')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (arg === 'addids') {
      if (!ensureOwner(interaction)) return;
      return interaction.showModal(securityManagerModal());
    }
    if (arg === 'delmanager') {
      if (!ensureOwner(interaction)) return;
      const ids = getManagerIds(interaction.guildId);
      if (!ids.length) {
        return interaction.reply({
          content: 'Модераторы защиты ещё не назначены.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: 'Выберите, кого убрать из модераторов защиты.',
        components: [await buildRemoveManagerMenu(interaction.guild, ids)],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!ensureSecurityAccess(interaction)) return;
    if (arg === 'toggle') {
      store.updateGuild(interaction.guildId, (guild) => {
        guild.security.enabled = !guild.security.enabled;
      });
      return showAdmin(interaction, 'security');
    }
    if (arg === 'limit') {
      return interaction.showModal(
        securityLimitModal(store.getGuild(interaction.guildId).security),
      );
    }
    if (arg === 'backup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const backup = await createBackup(interaction.guild);
      await interaction.message.edit(adminPayload(interaction, 'security')).catch(() => null);
      return interaction.editReply(
        `Резервная копия создана: **${backup.roles.length} ролей**, **${backup.channels.length} каналов**.`,
      );
    }
    if (arg === 'restore') {
      if (!store.getBackup(interaction.guildId)) {
        return interaction.reply({
          content: 'Резервная копия ещё не создана.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content:
          'Восстановить роли, каналы и разрешения из последней копии? ' +
          'Лишние объекты удалены не будут, сообщения не восстанавливаются.',
        components: [
          new ActionRowBuilder().setComponents(
            new ButtonBuilder()
              .setCustomId('admin:securityrestore:confirm')
              .setLabel('Подтвердить восстановление')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId('admin:securityrestore:cancel')
              .setLabel('Отмена')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (action === 'securityrestore') {
    if (!ensureSecurityAccess(interaction)) return;
    if (arg === 'cancel') {
      return interaction.update({ content: 'Восстановление отменено.', components: [] });
    }
    if (arg === 'confirm') {
      await interaction.deferUpdate();
      const result = await restoreBackup(interaction.guild);
      const details = result.errors.length
        ? `\nОшибки (${result.errors.length}):\n${truncate(result.errors.join('\n'), 900)}`
        : '';
      return interaction.editReply({
        content:
          `Восстановление завершено.\n` +
          `Роли: создано **${result.rolesCreated}**, обновлено **${result.rolesUpdated}**.\n` +
          `Каналы: создано **${result.channelsCreated}**, обновлено **${result.channelsUpdated}**.` +
          details,
        components: [],
      });
    }
  }

  if (action === 'caradd') {
    const vehicles = store.getGuild(interaction.guildId).autopark?.vehicles || [];
    if (vehicles.length >= 25) {
      return interaction.reply({
        content: 'В одной панели может быть не больше 25 машин.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(vehicleModal());
  }

  if (action === 'cartime') {
    const settings = store.getGuild(interaction.guildId);
    return interaction.showModal(vehicleTimeModal(settings.autopark?.durationMinutes));
  }

  if (action === 'gathadd') {
    const presets = store.getGuild(interaction.guildId).gatherings?.presets || [];
    if (presets.length >= 25) {
      return interaction.reply({
        content: 'Можно добавить не больше 25 типов сборов.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(gatheringPresetModal());
  }

  if (action === 'gathdelete') {
    const settings = store.getGuild(interaction.guildId);
    const selectedId =
      settings.gatherings?.selectedPresetId || settings.gatherings?.presets?.[0]?.id;
    if (!selectedId) {
      return interaction.reply({ content: 'Тип сбора не выбран.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.gatherings.presets = guild.gatherings.presets.filter((item) => item.id !== selectedId);
      guild.gatherings.selectedPresetId = guild.gatherings.presets[0]?.id || null;
    });
    await refreshGatheringPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'vzpstats') {
    return showVzpDatePicker(interaction);
  }

  if (action === 'gathclose') {
    const closed = await closeActiveGathering(interaction.client, interaction.guildId);
    if (!closed) {
      return interaction.reply({ content: 'Открытого сбора нет.', flags: MessageFlags.Ephemeral });
    }
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'cardelete' || action === 'carreset') {
    const settings = store.getGuild(interaction.guildId);
    const selectedId =
      settings.autopark?.selectedVehicleId || settings.autopark?.vehicles?.[0]?.id;
    if (!selectedId) {
      return interaction.reply({ content: 'Машины не выбраны.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      if (action === 'cardelete') {
        guild.autopark.vehicles = guild.autopark.vehicles.filter((car) => car.id !== selectedId);
        guild.autopark.selectedVehicleId = guild.autopark.vehicles[0]?.id || null;
      } else {
        const car = guild.autopark.vehicles.find((item) => item.id === selectedId);
        if (car) {
          car.inUseById = null;
          car.takenAt = null;
          car.returnAt = null;
        }
      }
    });
    await refreshAutoparkPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'autopark');
  }

  if (action === 'toggle' && isType(arg)) {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[arg].enabled = !guild.types[arg].enabled;
    });
    await refreshAllPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'ticket');
  }

  if (action === 'togglepage' && isType(arg)) {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[arg].enabled = !guild.types[arg].enabled;
    });
    await refreshAllPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, arg);
  }

  if (action === 'archpub') {
    return interaction.showModal(archivePublicModal(store.getGuild(interaction.guildId).archive || {}));
  }
  if (action === 'archroom') {
    return interaction.showModal(archiveRoomModal(store.getGuild(interaction.guildId).archive || {}));
  }
  if (action === 'archthreads') {
    return interaction.showModal(archiveThreadsModal(store.getGuild(interaction.guildId).archive || {}));
  }

  if (action === 'banner') return interaction.showModal(bannerModal(store.getGuild(interaction.guildId).bannerUrl));
  if (action === 'text') return interaction.showModal(textModal(store.getGuild(interaction.guildId)));
  if (action === 'cooldown') {
    return interaction.showModal(cooldownModal(store.getGuild(interaction.guildId).cooldownDays));
  }
  if (action === 'rename' && isType(arg)) {
    return interaction.showModal(renameModal(arg, store.getGuild(interaction.guildId).types[arg].label));
  }
  if (action === 'qadd' && isType(arg)) {
    const type = store.getType(interaction.guildId, arg);
    if (type.questions.length >= 5) {
      return interaction.reply({
        content: 'В одной заявке максимум 5 вопросов — столько полей позволяет Discord.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(questionModal(arg));
  }
  if (action === 'qdel' && isType(arg)) {
    const type = store.getType(interaction.guildId, arg);
    if (!type.questions.length) {
      return interaction.reply({ content: 'Вопросов нет.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
      content: 'Выберите вопрос, который нужно удалить.',
      components: [buildDeleteQuestionMenu(arg, type.questions)],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({ content: 'Неизвестная кнопка.', flags: MessageFlags.Ephemeral });
}

async function handleAdminSelect(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const typeKey = parts[2];
  const securityOnly = isSecurityOnlyUser(interaction);

  if (securityOnly && action !== 'security') return denySecurityOnly(interaction);
  if (action === 'accessaction' || action === 'accessroles') {
    if (!isAdmin(interaction.member)) return deny(interaction);
  } else if (!securityOnly) {
    const settings = store.getGuild(interaction.guildId);
    const settingsAccess = hasAccess(interaction.member, settings, 'settingsManage');
    const publishAccess = hasAccess(interaction.member, settings, 'panelsPublish');
    if (!settingsAccess && !(publishAccess && ['pickpanel', 'sendpanel'].includes(action))) {
      return deny(interaction);
    }
  }

  if (action === 'accessaction') {
    const selectedAction = interaction.values[0];
    if (!Object.hasOwn(ACCESS_ACTIONS, selectedAction)) {
      return interaction.reply({ content: 'Неизвестное действие.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.access.selectedAction = selectedAction;
    });
    return showAdmin(interaction, 'access');
  }

  if (action === 'accessroles') {
    store.updateGuild(interaction.guildId, (guild) => {
      const selectedAction = guild.access.selectedAction;
      if (Object.hasOwn(ACCESS_ACTIONS, selectedAction)) {
        guild.access.roles[selectedAction] = [...interaction.values];
      }
    });
    return showAdmin(interaction, 'access');
  }

  if (action === 'activityuser') {
    const userId = interaction.values[0];
    const periods = {};
    for (const period of ['day', 'week', 'month', 'all']) {
      periods[period] = activityForUser(interaction.guildId, userId, period);
    }
    return interaction.update({
      components: [buildActivityUserTab(userId, periods)],
    });
  }

  if (action === 'activityrole') {
    return showRoleActivity(interaction, interaction.values[0], 'week');
  }

  if (action === 'security') {
    if (typeKey === 'managers') {
      if (!ensureOwner(interaction)) return;
      const { next, added } = mergeManagerIds(interaction, interaction.values);
      if (!added.length) {
        return interaction.update({
          content:
            'Никого не добавлено. Эти люди уже имеют доступ, список заполнен (макс. 25) или это владелец / бот.',
          components: [],
        });
      }
      store.updateGuild(interaction.guildId, (guild) => {
        guild.security.managerUserIds = next;
      });
      await interaction.update({
        content: `Добавлены модераторы защиты: ${added.map((id) => `<@${id}>`).join(' ')}`,
        components: [],
      });
      await refreshStoredSecurityPanel(interaction);
      return;
    }
    if (typeKey === 'delpick') {
      if (!ensureOwner(interaction)) return;
      const remove = new Set(interaction.values);
      store.updateGuild(interaction.guildId, (guild) => {
        guild.security.managerUserIds = (guild.security.managerUserIds || []).filter((id) => !remove.has(id));
      });
      await interaction.update({
        content: `Убрано модераторов: **${remove.size}**.`,
        components: [],
      });
      await refreshStoredSecurityPanel(interaction);
      return;
    }
    if (!ensureSecurityAccess(interaction)) return;
    store.updateGuild(interaction.guildId, (guild) => {
      if (typeKey === 'channel') guild.security.logChannelId = interaction.values[0] || null;
      if (typeKey === 'users') guild.security.trustedUserIds = [...interaction.values];
      if (typeKey === 'roles') guild.security.trustedRoleIds = [...interaction.values];
    });
    return showAdmin(interaction, 'security');
  }

  if (action === 'carpick') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.autopark.selectedVehicleId = interaction.values[0] || null;
    });
    return showAdmin(interaction, 'autopark');
  }

  if (action === 'carrole') {
    const settings = store.getGuild(interaction.guildId);
    const selectedId =
      settings.autopark?.selectedVehicleId || settings.autopark?.vehicles?.[0]?.id;
    if (!selectedId) {
      return interaction.reply({ content: 'Сначала выберите машину.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      const car = guild.autopark.vehicles.find((item) => item.id === selectedId);
      if (car) car.roleIds = [...interaction.values];
    });
    await refreshAutoparkPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'autopark');
  }

  if (action === 'logs') {
    store.updateGuild(interaction.guildId, (guild) => {
      if (!guild.logs) guild.logs = {};
      if (typeKey === 'leave') guild.logs.leaveChannelId = interaction.values[0] || null;
      if (typeKey === 'moderation') guild.logs.moderationChannelId = interaction.values[0] || null;
      if (typeKey === 'roles') guild.logs.watchedRoleIds = [...interaction.values];
      if (typeKey === 'afk') {
        if (!guild.afk) guild.afk = { entries: [], logChannelId: null };
        guild.afk.logChannelId = interaction.values[0] || null;
      }
    });
    return showAdmin(interaction, 'logs');
  }

  if (action === 'staff') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.staffRoleIds = [...interaction.values];
    });
    return showAdmin(interaction, 'ticket');
  }

  if (action === 'logchannel') {
    if (!isType(typeKey)) {
      return interaction.reply({ content: 'Неизвестный тип заявок.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].logChannelId = interaction.values[0] || null;
    });
    return showAdmin(interaction, 'ticket');
  }

  if (action === 'gathpick') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.gatherings.selectedPresetId = interaction.values[0] || null;
    });
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'gathchannel') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.gatherings.listChannelId = interaction.values[0] || null;
    });
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'vzpdate') {
    return handleVzpDatePick(interaction);
  }

  if (action === 'vzpevent') {
    return handleVzpEventPick(interaction);
  }

  if (action === 'archcat') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.categoryId = interaction.values[0] || null;
    });
    return showAdmin(interaction, 'archive');
  }

  if (action === 'archstaff') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.staffRoleIds = [...interaction.values];
    });
    return showAdmin(interaction, 'archive');
  }

  if (action === 'archcreate') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.createRoleIds = [...interaction.values];
    });
    return showAdmin(interaction, 'archive');
  }

  if (action === 'archranks' || action === 'archtiers') {
    const ordered = [...interaction.values].sort((left, right) => {
      const a = interaction.guild.roles.cache.get(left)?.position || 0;
      const b = interaction.guild.roles.cache.get(right)?.position || 0;
      return a - b;
    });
    store.updateGuild(interaction.guildId, (guild) => {
      if (action === 'archranks') guild.archive.rankRoleIds = ordered;
      else guild.archive.tierRoleIds = ordered;
    });
    return showAdmin(interaction, 'archive');
  }

  if (action === 'gathstats') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.gatherings.statsChannelId = interaction.values[0] || null;
    });
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'gaththreadroles') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.gatherings.threadRoleIds = [...interaction.values];
    });
    await ensureGatheringThread(interaction.client, interaction.guildId).catch(() => null);
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'pickpanel') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.publishPanelKey = interaction.values[0] || 'tickets';
    });
    return showAdmin(interaction, 'panels');
  }

  if (action === 'sendpanel') {
    const channelId = interaction.values[0];
    const channel =
      interaction.channels?.get(channelId) || (await interaction.guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) {
      return interaction.reply({ content: 'Нужен текстовый канал.', flags: MessageFlags.Ephemeral });
    }
    try {
      let panelKey = store.getGuild(interaction.guildId).publishPanelKey;
      if (['gatherings', 'positions'].includes(panelKey)) {
        store.updateGuild(interaction.guildId, (guild) => {
          guild.publishPanelKey = 'tickets';
        });
        panelKey = 'tickets';
      }
      const result =
        panelKey === 'autopark'
          ? await publishAutoparkPanel(interaction, channel)
          : panelKey === 'afk'
            ? await publishAfkPanel(interaction, channel)
            : panelKey === 'archive'
              ? await publishArchivePanel(interaction, channel)
              : await publishPanel(interaction, channel);
      await interaction.update(adminPayload(interaction, 'panels'));
      await interaction.followUp({
        content: result.edited ? `Панель обновлена в ${channel}.` : `Панель опубликована в ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'Не удалось отправить панель. Проверьте права бота в этом канале.',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: 'Не удалось отправить панель. Проверьте права бота в этом канале.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    return;
  }

  if (action === 'review' && isType(typeKey)) {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].reviewChannelId = interaction.values[0];
    });
    return showAdmin(interaction, typeKey);
  }

  if (action === 'accepted' && isType(typeKey)) {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].acceptedChannelId = interaction.values[0];
    });
    return showAdmin(interaction, typeKey);
  }

  if (action === 'resultforum' && isType(typeKey)) {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].resultForumId = interaction.values[0];
    });
    return showAdmin(interaction, typeKey);
  }

  if (action === 'role' && isType(typeKey)) {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].roleId = interaction.values[0] || null;
    });
    return showAdmin(interaction, typeKey);
  }

  if (action === 'qdelpick' && isType(typeKey)) {
    const index = Number(interaction.values[0]);
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].questions.splice(index, 1);
    });
    await interaction.update({
      content: 'Вопрос удалён. Откройте настройки типа ещё раз, чтобы увидеть список.',
      components: [],
    });
    return;
  }

  return safeReply(interaction, { content: 'Неизвестный выбор.', flags: MessageFlags.Ephemeral });
}

async function handleAdminModal(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const securityOnly = isSecurityOnlyUser(interaction);

  if (securityOnly && action !== 'securitylimit' && action !== 'secmanager') {
    return denySecurityOnly(interaction);
  }
  if (!securityOnly && !ensureAdmin(interaction)) return;

  if (action === 'secmanager') {
    if (!ensureOwner(interaction)) return;
    const ids = parseUserIds(interaction.fields.getTextInputValue('ids'));
    if (!ids.length) {
      return interaction.reply({
        content: 'Не нашёл ни одного Discord ID. Вставьте числа из 17–20 цифр.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const { next, added } = mergeManagerIds(interaction, ids);
    if (!added.length) {
      return interaction.reply({
        content:
          'Никого не добавлено. Эти люди уже имеют доступ, список заполнен (макс. 25) или это владелец / бот.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.security.managerUserIds = next;
    });
    await interaction.reply({
      content: `Добавлены модераторы защиты: ${added.map((id) => `<@${id}>`).join(' ')}`,
      flags: MessageFlags.Ephemeral,
    });
    await refreshStoredSecurityPanel(interaction);
    return;
  }

  if (action === 'securitylimit') {
    if (!ensureSecurityAccess(interaction)) return;
    const actions = Number(interaction.fields.getTextInputValue('actions').trim());
    const seconds = Number(interaction.fields.getTextInputValue('seconds').trim());
    if (
      !Number.isInteger(actions) ||
      actions < 1 ||
      actions > 10 ||
      !Number.isInteger(seconds) ||
      seconds < 3 ||
      seconds > 60
    ) {
      return interaction.reply({
        content: 'Действия: от 1 до 10. Период: от 3 до 60 секунд.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.security.actionLimit = actions;
      guild.security.windowSeconds = seconds;
    });
    return showAdmin(interaction, 'security');
  }

  if (action === 'gathadd') {
    const name = interaction.fields.getTextInputValue('name').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    if (!name) {
      return interaction.reply({ content: 'Название не может быть пустым.', flags: MessageFlags.Ephemeral });
    }
    const settings = store.getGuild(interaction.guildId);
    if ((settings.gatherings?.presets || []).length >= 25) {
      return interaction.reply({ content: 'Достигнут лимит в 25 типов.', flags: MessageFlags.Ephemeral });
    }
    if (settings.gatherings.presets.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      return interaction.reply({
        content: 'Тип сбора с таким названием уже есть.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const id = shortId();
    store.updateGuild(interaction.guildId, (guild) => {
      guild.gatherings.presets.push({ id, name, description });
      guild.gatherings.selectedPresetId = id;
    });
    await refreshGatheringPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'gatherings');
  }

  if (action === 'caradd') {
    const name = interaction.fields.getTextInputValue('name').trim();
    const plate = interaction.fields.getTextInputValue('plate').trim().toUpperCase();
    const settings = store.getGuild(interaction.guildId);
    if ((settings.autopark?.vehicles || []).length >= 25) {
      return interaction.reply({ content: 'Достигнут лимит в 25 машин.', flags: MessageFlags.Ephemeral });
    }
    if (
      settings.autopark?.vehicles?.some(
        (car) => car.plate.toLowerCase() === plate.toLowerCase(),
      )
    ) {
      return interaction.reply({
        content: 'Машина с таким госномером уже существует.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const id = shortId();
    store.updateGuild(interaction.guildId, (guild) => {
      guild.autopark.vehicles.push({
        id,
        name,
        plate,
        roleIds: [],
        inUseById: null,
        takenAt: null,
        returnAt: null,
      });
      guild.autopark.selectedVehicleId = id;
    });
    await refreshAutoparkPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'autopark');
  }

  if (action === 'cartime') {
    const minutes = Number(interaction.fields.getTextInputValue('minutes').trim());
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      return interaction.reply({
        content: 'Укажите целое число минут от 1 до 10080.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.autopark.durationMinutes = minutes;
      for (const car of guild.autopark.vehicles) {
        if (car.inUseById) car.returnAt = Date.now() + minutes * 60 * 1000;
      }
    });
    await refreshAutoparkPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'autopark');
  }

  if (action === 'banner') {
    const url = interaction.fields.getTextInputValue('url').trim();
    if (url && !isHttpUrl(url)) {
      return interaction.reply({ content: 'Нужна обычная http/https ссылка.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.bannerUrl = url;
    });
    await refreshAllPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'ticket');
  }

  if (action === 'archpub') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.publicTitle = interaction.fields.getTextInputValue('title').trim();
      guild.archive.publicDescription = interaction.fields.getTextInputValue('description').trim();
      guild.archive.publicButton = interaction.fields.getTextInputValue('button').trim();
    });
    await refreshArchivePanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'archive');
  }

  if (action === 'archroom') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.roomTitle = interaction.fields.getTextInputValue('title').trim();
      guild.archive.roomDescription = interaction.fields.getTextInputValue('description').trim();
    });
    return showAdmin(interaction, 'archive');
  }

  if (action === 'archthreads') {
    const names = interaction.fields
      .getTextInputValue('names')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (!names.length) {
      return interaction.reply({ content: 'Нужно хотя бы одно название ветки.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.archive.threadNames = names;
    });
    return showAdmin(interaction, 'archive');
  }

  if (action === 'text') {
    store.updateGuild(interaction.guildId, (guild) => {
      guild.panelTitle = interaction.fields.getTextInputValue('title').trim().replace(/\n/g, ' ');
      guild.panelDescription = interaction.fields.getTextInputValue('description').trim();
    });
    await refreshAllPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'ticket');
  }

  if (action === 'cooldown') {
    const days = Number(interaction.fields.getTextInputValue('days').trim());
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      return interaction.reply({ content: 'Укажите целое число дней от 0 до 365.', flags: MessageFlags.Ephemeral });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      guild.cooldownDays = days;
    });
    await refreshAllPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, 'ticket');
  }

  if (action === 'rename') {
    const typeKey = parts[3];
    if (!isType(typeKey)) return interaction.reply({ content: 'Неизвестный тип.', flags: MessageFlags.Ephemeral });
    const label = interaction.fields.getTextInputValue('label').trim();
    if (!label) return interaction.reply({ content: 'Название не может быть пустым.', flags: MessageFlags.Ephemeral });
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].label = label;
    });
    await refreshAllPanels(interaction.client, interaction.guildId);
    return showAdmin(interaction, typeKey);
  }

  if (action === 'qadd') {
    const typeKey = parts[3];
    if (!isType(typeKey)) return interaction.reply({ content: 'Неизвестный тип.', flags: MessageFlags.Ephemeral });
    const type = store.getType(interaction.guildId, typeKey);
    if (type.questions.length >= 5) {
      return interaction.reply({ content: 'Уже 5 вопросов.', flags: MessageFlags.Ephemeral });
    }
    const label = interaction.fields.getTextInputValue('label').trim();
    const style = parseStyle(interaction.fields.getTextInputValue('style'));
    const required = parseBool(interaction.fields.getTextInputValue('required'));
    store.updateGuild(interaction.guildId, (guild) => {
      guild.types[typeKey].questions.push({
        label,
        style,
        required,
        maxLength: style === 'paragraph' ? 800 : 120,
      });
    });
    return showAdmin(interaction, typeKey);
  }

  return interaction.reply({ content: 'Неизвестная форма.', flags: MessageFlags.Ephemeral });
}

module.exports = {
  handlePanelCommand,
  handleAdminButton,
  handleAdminSelect,
  handleAdminModal,
  showAdmin,
};
