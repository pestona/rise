const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const store = require('./store');
const {
  isType,
  shortId,
  truncate,
  cooldownLeft,
  formatDuration,
  safeReply,
  canReview,
  slugPart,
} = require('./util');
const { v2Flags, buildPublicPanel, buildApplicationContainer } = require('./ui');

async function refreshAllPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const payload = {
    components: [buildPublicPanel(settings)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };

  const dead = [];
  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'tickets')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(payload);
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель:', error.message);
    }
  }
  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function refreshPublicPanel(client, guildId) {
  return refreshAllPanels(client, guildId);
}

async function publishPanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const key = settings.publishPanelKey || 'tickets';
  const payload = {
    components: [buildPublicPanel(settings)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };

  const existing = store.listPanels(interaction.guildId).find((item) => item.key === key && item.channelId === channel.id);
  if (existing) {
    try {
      const old = await channel.messages.fetch(existing.messageId);
      await old.edit(payload);
      store.rememberPanel(interaction.guildId, {
        key,
        channelId: channel.id,
        messageId: old.id,
      });
      return { edited: true, message: old };
    } catch {
      // старое сообщение удалили — отправим новое
    }
  }

  const message = await channel.send(payload);
  store.rememberPanel(interaction.guildId, {
    key,
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

function trackPanelFromInteraction(interaction) {
  if (!interaction.guildId || !interaction.message) return;
  store.rememberPanel(interaction.guildId, {
    key: 'tickets',
    channelId: interaction.message.channelId,
    messageId: interaction.message.id,
  });
}

async function resetApplyPanel(interaction) {
  trackPanelFromInteraction(interaction);
  await refreshAllPanels(interaction.client, interaction.guildId);
}

function applicationModal(typeKey, type) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket:modal:${typeKey}`)
    .setTitle(truncate(`Заявка ${type.label}`, 45));

  const questions = type.questions.slice(0, 5);
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q${i}`)
          .setLabel(truncate(q.label, 45))
          .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(q.required !== false)
          .setMaxLength(Math.min(q.maxLength || (q.style === 'paragraph' ? 800 : 120), 1024))
          .setPlaceholder(q.label.length > 45 ? truncate(q.label, 100) : 'Введите ответ'),
      ),
    );
  }
  return modal;
}

function ticketName(app, type) {
  return `${String(app.number).padStart(4, '0')} - ${type.label.toUpperCase()}`;
}

async function sendTicketLog(interaction, app, settings, decision, options = {}) {
  if (!settings.ticketLogChannelId) return;
  const channel = await interaction.guild.channels.fetch(settings.ticketLogChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return;

  const type = settings.types[app.type];
  const action = decision === 'accepted' ? 'принял заявку' : 'отказал в заявке';
  const lines = [
    `<@${options.actorId}> **${action}** <@${app.userId}> типа **${type?.label || app.type.toUpperCase()}**.`,
  ];
  if (decision === 'rejected' && options.reason) {
    lines.push(`**Причина:** ${options.reason}`);
  }
  if (options.archiveThread) {
    const url = `https://discord.com/channels/${interaction.guildId}/${options.archiveThread.id}`;
    lines.push(`Заявка находится [ТУТ](${url}).`);
  } else {
    lines.push('Архив заявки не создан.');
  }

  try {
    await channel.send({
      content: lines.join('\n'),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.warn('Не удалось отправить лог тикета:', error.message);
  }
}

async function handleApplySelect(interaction) {
  trackPanelFromInteraction(interaction);
  const typeKey = interaction.values[0];
  if (!isType(typeKey)) {
    await safeReply(interaction, { content: 'Неизвестный тип заявки.', flags: MessageFlags.Ephemeral });
    await resetApplyPanel(interaction);
    return;
  }

  const settings = store.getGuild(interaction.guildId);
  const type = settings.types[typeKey];

  if (!type.enabled) {
    await interaction.reply({
      content: `Набор **${type.label}** сейчас закрыт.`,
      flags: MessageFlags.Ephemeral,
    });
    await resetApplyPanel(interaction);
    return;
  }

  if (!type.reviewChannelId) {
    await interaction.reply({
      content: 'Канал заявок ещё не настроен. Напишите администрации.',
      flags: MessageFlags.Ephemeral,
    });
    await resetApplyPanel(interaction);
    return;
  }

  if (!type.questions.length) {
    await interaction.reply({
      content: 'Вопросы для этой заявки не настроены.',
      flags: MessageFlags.Ephemeral,
    });
    await resetApplyPanel(interaction);
    return;
  }

  const member = interaction.member;
  if (type.roleId && member.roles.cache.has(type.roleId)) {
    await interaction.reply({
      content: `У вас уже есть роль **${type.label}**.`,
      flags: MessageFlags.Ephemeral,
    });
    await resetApplyPanel(interaction);
    return;
  }

  if (store.pendingApp(interaction.guildId, interaction.user.id, typeKey)) {
    await interaction.reply({
      content: `У вас уже есть заявка **${type.label}** на рассмотрении.`,
      flags: MessageFlags.Ephemeral,
    });
    await resetApplyPanel(interaction);
    return;
  }

  const rejected = store.lastRejected(interaction.guildId, interaction.user.id, typeKey);
  const left = cooldownLeft(rejected?.reviewedAt, settings.cooldownDays);
  if (left > 0) {
    await interaction.reply({
      content: `После отказа повторная заявка **${type.label}** доступна через **${formatDuration(left)}**.`,
      flags: MessageFlags.Ephemeral,
    });
    await resetApplyPanel(interaction);
    return;
  }

  await interaction.showModal(applicationModal(typeKey, type));
  await resetApplyPanel(interaction);
}

async function handleApplyModal(interaction) {
  const typeKey = interaction.customId.split(':')[2];
  if (!isType(typeKey)) {
    return safeReply(interaction, { content: 'Неизвестный тип заявки.', flags: MessageFlags.Ephemeral });
  }

  const settings = store.getGuild(interaction.guildId);
  const type = settings.types[typeKey];

  if (!type.enabled) {
    return interaction.reply({ content: `Набор **${type.label}** закрыт.`, flags: MessageFlags.Ephemeral });
  }

  if (store.pendingApp(interaction.guildId, interaction.user.id, typeKey)) {
    return interaction.reply({
      content: 'Заявка этого типа уже на рассмотрении.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const answers = type.questions.map((q, i) => {
    let value = '';
    try {
      value = interaction.fields.getTextInputValue(`q${i}`)?.trim() || '';
    } catch {
      value = '';
    }
    return { q: q.label, a: value };
  });

  const reviewChannel = await interaction.guild.channels.fetch(type.reviewChannelId).catch(() => null);
  if (!reviewChannel?.isTextBased() || reviewChannel.type === ChannelType.GuildForum) {
    return interaction.reply({
      content: 'Не удалось отправить заявку: канал проверки недоступен.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const app = {
    id: shortId(),
    number: store.nextNumber(interaction.guildId),
    guildId: interaction.guildId,
    type: typeKey,
    userId: interaction.user.id,
    answers,
    status: 'pending',
    createdAt: Date.now(),
    reviewedAt: null,
    reviewerId: null,
    reason: null,
    reviewChannelId: type.reviewChannelId,
    reviewMessageId: null,
  };

  const settingsForSend = settings;
  const staffPing = settingsForSend.staffRoleId ? `<@&${settingsForSend.staffRoleId}> новая заявка` : '';

  let sent;
  try {
    sent = await reviewChannel.send({
      components: [
        buildApplicationContainer(app, settingsForSend, {
          staffPing,
        }),
      ],
      flags: v2Flags(false),
      allowedMentions: {
        users: [],
        roles: settingsForSend.staffRoleId ? [settingsForSend.staffRoleId] : [],
      },
    });
  } catch (error) {
    console.error('Не удалось отправить заявку:', error);
    return interaction.reply({
      content: 'Не удалось отправить заявку в канал проверки. Проверьте права бота.',
      flags: MessageFlags.Ephemeral,
    });
  }

  store.addApp({
    ...app,
    reviewChannelId: sent.channelId,
    reviewMessageId: sent.id,
  });

  return interaction.reply({
    content: `Заявка **${type.label}** отправлена. Обычно её смотрят в течение 1–2 дней.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function refreshReviewMessage(client, app, settings, extra = {}) {
  if (!app.reviewChannelId || !app.reviewMessageId) return;
  try {
    const channel = await client.channels.fetch(app.reviewChannelId);
    const message = await channel.messages.fetch(app.reviewMessageId);
    await message.edit({
      components: [
        buildApplicationContainer(app, settings, {
          statusText: extra.statusText,
          reviewerId: app.reviewerId,
          reason: app.reason,
          suppressActions: extra.suppressActions,
        }),
      ],
      flags: v2Flags(false),
    });
  } catch (error) {
    console.warn('Не удалось обновить сообщение заявки:', error.message);
  }
}

async function handleReviewButton(interaction) {
  const [, action, appId] = interaction.customId.split(':');
  const settings = store.getGuild(interaction.guildId);

  if (!canReview(interaction.member, settings)) {
    return interaction.reply({
      content: 'Принимать заявки может только персонал.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const app = store.findApp(appId);
  if (!app || app.guildId !== interaction.guildId) {
    return interaction.reply({ content: 'Заявка не найдена.', flags: MessageFlags.Ephemeral });
  }
  if (!['pending', 'interview'].includes(app.status)) {
    return interaction.reply({ content: 'Эта заявка уже рассмотрена.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'no') {
    const modal = new ModalBuilder()
      .setCustomId(`rev:reason:${app.id}`)
      .setTitle('Отклонить заявку')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Причина отказа')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500)
            .setPlaceholder('Кратко напишите, почему отказали'),
        ),
      );
    return interaction.showModal(modal);
  }

  if (action === 'call') {
    if (app.status !== 'pending') {
      return interaction.reply({ content: 'Канал обзвона уже создан.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    await moveToInterview(interaction, app);
    return;
  }

  if (action !== 'ok' || app.status !== 'interview') {
    return interaction.reply({
      content: 'Сначала переведите заявку на обзвон.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();
  await acceptApplication(interaction, app);
}

async function moveToInterview(interaction, app) {
  const settings = store.getGuild(interaction.guildId);
  const type = settings.types[app.type];
  const member = await interaction.guild.members.fetch(app.userId).catch(() => null);

  if (!type.acceptedChannelId) {
    await interaction.followUp({
      content: 'Категория каналов обзвона не настроена.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let createdChannel;
  try {
    createdChannel = await createInterviewChannel(interaction, app, type, settings, member);
  } catch (error) {
    console.error('Не удалось создать канал обзвона:', error);
    await interaction.followUp({
      content: `Не удалось создать канал обзвона: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  store.updateApp(app.id, {
    status: 'interview',
    interviewChannelId: createdChannel.id,
    interviewById: interaction.user.id,
    interviewAt: Date.now(),
  });
  const updated = store.findApp(app.id);

  const interviewMessage = await createdChannel.send({
    components: [
      buildApplicationContainer(updated, settings, {
        statusText: 'На обзвоне',
        reviewerId: interaction.user.id,
      }),
    ],
    flags: v2Flags(false),
    allowedMentions: { users: member ? [member.id] : [] },
  });
  store.updateApp(app.id, { interviewMessageId: interviewMessage.id });

  await refreshReviewMessage(interaction.client, store.findApp(app.id), settings, {
    statusText: `На обзвоне · ${createdChannel}`,
    suppressActions: true,
  });
  await interaction.followUp({
    content: `Канал обзвона создан: ${createdChannel}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function acceptApplication(interaction, app) {
  const settings = store.getGuild(interaction.guildId);
  const type = settings.types[app.type];
  const member = await interaction.guild.members.fetch(app.userId).catch(() => null);

  let roleNote;
  if (!member) {
    roleNote = 'Пользователь вышел с сервера, роль не выдана.';
  } else if (!type.roleId) {
    roleNote = 'Роль для этого типа не настроена.';
  } else {
    try {
      await member.roles.add(type.roleId, `Заявка ${type.label} #${app.number} принята`);
      roleNote = `Выдана роль <@&${type.roleId}>.`;
    } catch {
      roleNote = 'Не удалось выдать роль: проверьте права бота и позицию роли.';
    }
  }

  store.updateApp(app.id, {
    status: 'accepted',
    reviewedAt: Date.now(),
    reviewerId: interaction.user.id,
    reason: roleNote,
  });
  const updated = store.findApp(app.id);

  await refreshReviewMessage(interaction.client, updated, settings, {
    statusText: 'Принята',
  });
  await refreshInterviewMessage(interaction.client, updated, settings, 'Принята');
  const resultThread = await archiveResult(interaction, updated, type, settings);
  await sendTicketLog(interaction, updated, settings, 'accepted', {
    actorId: interaction.user.id,
    archiveThread: resultThread,
  });

  await interaction.followUp({
    content:
      `Заявка #${app.number} принята. ${roleNote}` +
      (resultThread ? ` Итог: ${resultThread}` : ' Форум результатов не настроен.'),
    flags: MessageFlags.Ephemeral,
  });
  await deleteInterviewChannel(interaction, updated);
}

async function refreshInterviewMessage(client, app, settings, statusText) {
  if (!app.interviewChannelId || !app.interviewMessageId) return;
  try {
    const channel = await client.channels.fetch(app.interviewChannelId);
    const message = await channel.messages.fetch(app.interviewMessageId);
    await message.edit({
      components: [
        buildApplicationContainer(app, settings, {
          statusText,
          reviewerId: app.reviewerId || app.interviewById,
          reason: app.reason,
        }),
      ],
      flags: v2Flags(false),
    });
  } catch (error) {
    console.warn('Не удалось обновить панель в канале обзвона:', error.message);
  }
}

async function createInterviewChannel(interaction, app, type, settings, member) {
  const parent = await interaction.guild.channels.fetch(type.acceptedChannelId).catch(() => null);
  if (!parent || parent.type !== ChannelType.GuildCategory) {
    throw new Error('Нужно выбрать категорию, а не текстовый канал');
  }

  const typeSlug = slugPart(type.label, app.type || 'ticket');
  let name = `${String(app.number).padStart(4, '0')}-${typeSlug}`.slice(0, 90);
  if (interaction.guild.channels.cache.some((channel) => channel.name === name)) {
    name = `${name}-${shortId()}`.slice(0, 100);
  }

  const overwrites = [
    {
      id: interaction.guild.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  if (member) {
    overwrites.push({
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }

  if (settings.staffRoleId) {
    overwrites.push({
      id: settings.staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  return interaction.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    topic: `${ticketName(app, type)} · автор <@${app.userId}>`,
    permissionOverwrites: overwrites,
    reason: `${ticketName(app, type)} переведена на обзвон`,
  });
}

async function archiveResult(interaction, app, type, settings) {
  if (app.resultThreadId) {
    return interaction.guild.channels.fetch(app.resultThreadId).catch(() => null);
  }
  if (!type.resultForumId) return null;

  const forum = await interaction.guild.channels.fetch(type.resultForumId).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    console.warn(`Форум результатов ${type.resultForumId} недоступен`);
    return null;
  }

  try {
    const thread = await forum.threads.create({
      name: ticketName(app, type),
      message: {
        components: [
          buildApplicationContainer(app, settings, {
            statusText: app.status === 'accepted' ? 'Принята' : 'Отклонена',
            reviewerId: app.reviewerId,
            reason: app.reason,
            suppressActions: true,
          }),
        ],
        flags: v2Flags(false),
        allowedMentions: { parse: [] },
      },
      reason: `Завершён тикет ${ticketName(app, type)}`,
    });
    store.updateApp(app.id, { resultThreadId: thread.id });
    return thread;
  } catch (error) {
    console.error('Не удалось создать пост результата в форуме:', error);
    return null;
  }
}

async function deleteInterviewChannel(interaction, app) {
  if (!app.interviewChannelId) return;
  try {
    const channel = await interaction.guild.channels.fetch(app.interviewChannelId);
    if (channel?.deletable) {
      await channel.delete(`Тикет ${String(app.number).padStart(4, '0')} завершён`);
    }
  } catch (error) {
    if (error.code !== 10003) {
      console.warn('Не удалось удалить канал обзвона:', error.message);
    }
  }
}

async function handleRejectModal(interaction) {
  const appId = interaction.customId.split(':')[2];
  const settings = store.getGuild(interaction.guildId);

  if (!canReview(interaction.member, settings)) {
    return interaction.reply({ content: 'Недостаточно прав.', flags: MessageFlags.Ephemeral });
  }

  const app = store.findApp(appId);
  if (!app || !['pending', 'interview'].includes(app.status)) {
    return interaction.reply({ content: 'Заявка уже рассмотрена или не найдена.', flags: MessageFlags.Ephemeral });
  }

  const reason = interaction.fields.getTextInputValue('reason').trim();
  store.updateApp(app.id, {
    status: 'rejected',
    reviewedAt: Date.now(),
    reviewerId: interaction.user.id,
    reason,
  });
  const updated = store.findApp(app.id);
  const type = settings.types[app.type];

  await interaction.deferUpdate();
  await refreshReviewMessage(interaction.client, updated, settings, {
    statusText: 'Отклонена',
  });
  await refreshInterviewMessage(interaction.client, updated, settings, 'Отклонена');
  const resultThread = await archiveResult(interaction, updated, type, settings);
  await sendTicketLog(interaction, updated, settings, 'rejected', {
    actorId: interaction.user.id,
    reason,
    archiveThread: resultThread,
  });

  await interaction.followUp({
    content:
      `Заявка #${app.number} отклонена.` +
      (resultThread ? ` Итог: ${resultThread}` : ' Форум результатов не настроен.'),
    flags: MessageFlags.Ephemeral,
  });
  await deleteInterviewChannel(interaction, updated);
}

module.exports = {
  refreshPublicPanel,
  refreshAllPanels,
  publishPanel,
  handleApplySelect,
  handleApplyModal,
  handleReviewButton,
  handleRejectModal,
};
