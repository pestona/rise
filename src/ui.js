const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const { ACCESS_ACTIONS, fillPlaceholders, statusLabel, truncate } = require('./util');

function v2Flags(ephemeral = false) {
  return ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2;
}

function addBanner(container, url) {
  if (!url) return container;
  return container.addMediaGalleryComponents((gallery) =>
    gallery.addItems((item) => item.setURL(url).setDescription('Баннер заявок')),
  );
}

function buildPublicPanel(guild) {
  const vzp = guild.types.vzp;
  const rp = guild.types.rp;
  const description = fillPlaceholders(guild.panelDescription, guild).replace(/\n{2,}/g, '\n');
  const title = fillPlaceholders(guild.panelTitle, guild);

  const container = new ContainerBuilder().setAccentColor(guild.accentColor || 0x111111);
  addBanner(container, guild.bannerUrl);

  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## ${title}\n` +
          `${description}\n` +
          `**Статус набора:** ${vzp.label} — ${statusLabel(vzp.enabled)} · ` +
          `${rp.label} — ${statusLabel(rp.enabled)}\n` +
          '**Подать заявку:**',
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket:apply')
          .setPlaceholder('Подать заявку в семью')
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(`Заявка ${vzp.label}`)
              .setDescription(vzp.enabled ? 'Набор открыт' : 'Набор закрыт')
              .setValue('vzp')
              .setEmoji(vzp.enabled ? '🟢' : '🔴'),
            new StringSelectMenuOptionBuilder()
              .setLabel(`Заявка ${rp.label}`)
              .setDescription(rp.enabled ? 'Набор открыт' : 'Набор закрыт')
              .setValue('rp')
              .setEmoji(rp.enabled ? '🟢' : '🔴'),
          ),
      ),
    );

  return container;
}

function channelMention(id) {
  return id ? `<#${id}>` : 'не задан';
}

function roleMention(id) {
  return id ? `<@&${id}>` : 'не задана';
}

function roleMentions(ids) {
  return ids?.length ? ids.map((id) => roleMention(id)).join(' ') : 'не выбраны';
}

function questionsPreview(questions) {
  if (!questions?.length) return '_Вопросы не добавлены_';
  return questions
    .map((q, i) => {
      const kind = q.style === 'paragraph' ? 'абзац' : 'короткий';
      const req = q.required ? 'обяз.' : 'необяз.';
      return `${i + 1}. ${q.label}  ·  ${kind}, ${req}`;
    })
    .join('\n');
}

function mark(ok) {
  return ok ? '✅' : '❌';
}

function formatDuration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} мин.`;
  return rest ? `${hours} ч. ${rest} мин.` : `${hours} ч.`;
}

function backToHubButton() {
  return new ButtonBuilder().setCustomId('admin:hub').setLabel('Назад').setStyle(ButtonStyle.Secondary);
}

const PUBLIC_PANELS = [
  {
    key: 'tickets',
    label: 'Заявки в семью',
    description: 'Панель подачи заявок',
  },
  {
    key: 'autopark',
    label: 'Автопарк',
    description: 'Выдача и возврат машин',
  },
  {
    key: 'afk',
    label: 'AFK',
    description: 'Уход в AFK с причиной и временем',
  },
];

function buildAdminHub(guild, botName) {
  const name = botName || 'RISE';
  const panelReady = Boolean(guild.panel?.channelId);
  const ticketReady = Boolean(
    guild.types?.vzp?.enabled || guild.types?.rp?.enabled || guild.staffRoleIds?.length,
  );
  const logsReady = Boolean(guild.logs?.leaveChannelId || guild.logs?.moderationChannelId);
  const autoparkReady = Boolean(guild.autopark?.vehicles?.length);
  const gatheringsReady = true;
  const securityReady = Boolean(guild.security?.enabled && guild.security?.logChannelId);

  const container = new ContainerBuilder().setAccentColor(0x2b2d31);
  container
    .addTextDisplayComponents((text) => text.setContent(`## Админка ${name}`))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Выбери раздел — у каждого своя настройка.\n\n` +
          `${mark(panelReady)} Панели  ·  ${mark(ticketReady)} Тикеты  ·  ` +
          `${mark(logsReady)} Логи  ·  ${mark(autoparkReady)} Автопарк  ·  ` +
          `${mark(gatheringsReady)} Сборы  ·  ${mark(securityReady)} Защита`,
      ),
    )
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((text) => text.setContent('Разделы: команда `/panel`'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:tab:panels')
          .setLabel('Панели')
          .setEmoji('📋')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:ticket')
          .setLabel('Тикеты')
          .setEmoji('🎫')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:logs')
          .setLabel('Логи')
          .setEmoji('📜')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:moveall')
          .setLabel('Все ко мне')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin:tab:autopark')
          .setLabel('Автопарк')
          .setEmoji('🚗')
          .setStyle(ButtonStyle.Primary),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:tab:summary')
          .setLabel('Сводка')
          .setEmoji('📊')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('admin:tab:gatherings')
          .setLabel('Сборы')
          .setEmoji('📣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:security')
          .setLabel('Защита')
          .setEmoji('🛡️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:check')
          .setLabel('Проверить всё')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin:tab:activity')
          .setLabel('Активность')
          .setEmoji('📈')
          .setStyle(ButtonStyle.Primary),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:tab:access')
          .setLabel('Доступ')
          .setEmoji('🔐')
          .setStyle(ButtonStyle.Secondary),
      ),
    );

  return container;
}

function buildSummary(guild) {
  const panelNames = {
    tickets: 'Заявки в семью',
    autopark: 'Автопарк',
    afk: 'AFK',
    gatherings: 'Сборы',
  };
  const published = (guild.panels || []).length
    ? guild.panels
        .map((panel) => `• ${panelNames[panel.key] || panel.key}: ${channelMention(panel.channelId)}`)
        .join('\n')
    : '• Нет опубликованных панелей';
  const watchedRoles = guild.logs?.watchedRoleIds?.length
    ? guild.logs.watchedRoleIds.map((id) => roleMention(id)).join(' ')
    : 'не выбраны';
  const vehicles = guild.autopark?.vehicles || [];
  const vehicleBindings = vehicles.length
    ? vehicles
        .map(
          (car) =>
            `• **${car.name}** \`${car.plate}\` — ` +
            `${car.roleIds?.length ? car.roleIds.map((id) => roleMention(id)).join(' ') : 'без ограничения'}`,
        )
        .join('\n')
    : '• Машины не добавлены';

  const typeSummary = (key) => {
    const type = guild.types[key];
    return (
      `**${type.label}** — ${statusLabel(type.enabled)}\n` +
      `Проверка: ${channelMention(type.reviewChannelId)} · Обзвон: ${channelMention(type.acceptedChannelId)}\n` +
      `Архив: ${channelMention(type.resultForumId)} · Логи: ${channelMention(type.logChannelId)} · ` +
      `Роль: ${roleMention(type.roleId)} · ` +
      `Вопросов: ${type.questions?.length || 0}`
    );
  };
  const activeGathering = guild.gatherings?.active;
  const gatheringPings = activeGathering
    ? [
        activeGathering.pingEveryone ? '@everyone' : null,
        ...(activeGathering.pingRoleIds || []).map((id) => roleMention(id)),
      ]
        .filter(Boolean)
        .join(' ') || 'без пинга'
    : 'нет активного сбора';

  const content =
    `## Сводка привязок\n` +
    `**Админ-панель:** ${channelMention(guild.adminPanel?.channelId)}\n\n` +
    `### Панели\n${published}\n\n` +
    `### Тикеты\n` +
    `Персонал: ${roleMentions(guild.staffRoleIds)}\n` +
    `${typeSummary('vzp')}\n${typeSummary('rp')}\n\n` +
    `### Общие логи\n` +
    `Выходы: ${channelMention(guild.logs?.leaveChannelId)}\n` +
    `Кики/баны: ${channelMention(guild.logs?.moderationChannelId)}\n` +
    `AFK: ${channelMention(guild.afk?.logChannelId)}\n` +
    `Роли выходов: ${watchedRoles}\n\n` +
    `### Автопарк\n` +
    `Общее время аренды: **${guild.autopark?.durationMinutes || 60} мин.** · Машин: **${vehicles.length}**\n` +
    `${vehicleBindings}\n\n` +
    `### Сборы\n` +
    `Пинг активного сбора: ${gatheringPings}\n` +
    `Активный: **${activeGathering && !activeGathering.closed ? `${activeGathering.content || activeGathering.title}` : 'нет'}**`;

  return new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents((text) => text.setContent(truncate(content, 3800)))
    .addActionRowComponents((row) => row.setComponents(backToHubButton()));
}

function buildSecurityTab(guild, hasBackup = false, options = {}) {
  const security = guild.security || {};
  const securityOnly = Boolean(options.securityOnly);
  const trustedUsers = security.trustedUserIds?.length
    ? security.trustedUserIds.map((id) => `<@${id}>`).join(' ')
    : 'не выбраны';
  const trustedRoles = security.trustedRoleIds?.length
    ? security.trustedRoleIds.map((id) => roleMention(id)).join(' ')
    : 'не выбраны';
  const managers = security.managerUserIds?.length
    ? security.managerUserIds.map((id) => `<@${id}>`).join(' ')
    : 'не назначены';
  const backupText = security.lastBackupAt
    ? `<t:${Math.floor(security.lastBackupAt / 1000)}:F>`
    : 'не создана';
  const firstRowButtons = [
    new ButtonBuilder()
      .setCustomId('admin:security:toggle')
      .setLabel(security.enabled ? 'Выключить Anti-Nuke' : 'Включить Anti-Nuke')
      .setStyle(security.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('admin:security:limit')
      .setLabel('Настроить лимит')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (!securityOnly) {
    firstRowButtons.push(
      new ButtonBuilder()
        .setCustomId('admin:security:addmanager')
        .setLabel('Добавить ID')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('admin:security:delmanager')
        .setLabel('Убрать')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!security.managerUserIds?.length),
      backToHubButton(),
    );
  }

  return new ContainerBuilder()
    .setAccentColor(security.enabled ? 0x57f287 : 0xed4245)
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Защита сервера\n` +
          `Anti-Nuke: **${security.enabled ? 'включён' : 'выключен'}**\n` +
          `Канал тревог: ${channelMention(security.logChannelId)}\n` +
          `Лимит: **${security.actionLimit || 3} действий за ${security.windowSeconds || 10} сек.**\n` +
          `Белый список пользователей: ${trustedUsers}\n` +
          `Белый список ролей: ${trustedRoles}\n` +
          `Модераторы защиты: ${managers}\n` +
          `Резервная копия: ${backupText}\n` +
          `Автокопирование: **каждые 24 часа**\n` +
          `_Настраивать защиту могут владелец, главный модератор бота и назначенные модераторы. Добавлять модераторов может только владелец._`,
      ),
    )
    .addActionRowComponents((row) => row.setComponents(...firstRowButtons))
    .addTextDisplayComponents((text) => text.setContent('**Канал тревог Anti-Nuke**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:security:channel')
          .setPlaceholder('Выберите канал тревог')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Доверенные пользователи**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('admin:security:users')
          .setPlaceholder('Выберите пользователей')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Доверенные роли**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:security:roles')
          .setPlaceholder('Выберите роли')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:security:backup')
          .setLabel('Создать копию')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:security:restore')
          .setLabel('Восстановить')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!hasBackup),
      ),
    );
}

function buildPanelsTab(guild) {
  const selected = guild.publishPanelKey || 'tickets';
  const selectedMeta = PUBLIC_PANELS.find((item) => item.key === selected) || PUBLIC_PANELS[0];
  const published = (guild.panels || [])
    .map((item) => channelMention(item.channelId))
    .filter(Boolean);
  const publishedText = published.length ? published.join(', ') : 'ещё не опубликована';

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container
    .addTextDisplayComponents((text) => text.setContent('## Панели'))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Выбери панель и канал, куда её отправить.\n\n` +
          `Сейчас: **${selectedMeta.label}**\n` +
          `Канал: ${publishedText}`,
      ),
    )
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((text) => text.setContent('**Какая панель**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId('admin:pickpanel')
          .setPlaceholder('Выберите панель')
          .addOptions(
            PUBLIC_PANELS.map((item) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(item.label)
                .setDescription(item.description)
                .setValue(item.key)
                .setDefault(item.key === selected),
            ),
          ),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**В какой канал**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:sendpanel')
          .setPlaceholder('Выберите канал')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1),
      ),
    )
    .addActionRowComponents((row) => row.setComponents(backToHubButton()));

  return container;
}

function buildLogsTab(guild) {
  const logs = guild.logs || {};
  const watched = Array.isArray(logs.watchedRoleIds) ? logs.watchedRoleIds : [];
  const rolesText = watched.length ? watched.map((id) => roleMention(id)).join(', ') : 'не выбраны';

  const container = new ContainerBuilder().setAccentColor(0xed4245);
  container
    .addTextDisplayComponents((text) => text.setContent('## Логи'))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Выходы: ${channelMention(logs.leaveChannelId)}\n` +
          `Кики и баны: ${channelMention(logs.moderationChannelId)}\n` +
          `AFK: ${channelMention(guild.afk?.logChannelId)}\n` +
          `Отслеживаемые роли: ${rolesText}`,
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Канал логов выхода с сервера**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:logs:leave')
          .setPlaceholder('Канал выходов')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Какие роли отслеживать при выходе**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:logs:roles')
          .setPlaceholder('Выберите одну или несколько ролей')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Канал логов киков и банов**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:logs:moderation')
          .setPlaceholder('Канал киков и банов')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Канал логов AFK**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:logs:afk')
          .setPlaceholder('Канал логов AFK')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addActionRowComponents((row) => row.setComponents(backToHubButton()));

  return container;
}

function buildAutoparkPanel(guild) {
  const vehicles = (guild.autopark?.vehicles || []).slice(0, 25);
  const roleList = (car) =>
    car.roleIds?.length ? car.roleIds.map((id) => `<@&${id}>`).join(' ') : 'без ограничения';
  const free = vehicles.filter((car) => !car.inUseById);
  const occupied = vehicles.filter((car) => car.inUseById);
  const freeText = free.length
    ? free
        .map(
          (car) =>
            `🚙 **${car.name}**\n` +
            `> Номер: \`${car.plate}\`\n` +
            `> Доступ: ${roleList(car)}`,
        )
        .join('\n\n')
    : '> *Свободных машин нет*';
  const occupiedText = occupied.length
    ? occupied
        .map(
          (car) =>
            `🚘 **${car.name}**\n` +
            `> Номер: \`${car.plate}\`\n` +
            `> Водитель: <@${car.inUseById}>`,
        )
        .join('\n\n')
    : '> *Занятых машин нет*';

  const embed = new EmbedBuilder()
    .setColor(0x2b8cff)
    .setTitle('🚘 Автопарк семьи')
    .setDescription(
      `**Всего машин:** ${vehicles.length}　` +
        `**Свободно:** ${free.length}　` +
        `**Занято:** ${occupied.length}\n` +
        '> Нажмите нужное действие и выберите автомобиль.',
    )
    .addFields(
      { name: `🟢 СВОБОДНЫЕ · ${free.length}`, value: truncate(freeText, 1024), inline: true },
      { name: `🔴 ЗАНЯТЫЕ · ${occupied.length}`, value: truncate(occupiedText, 1024), inline: true },
    )
    .setFooter({ text: 'Статусы обновляются автоматически' });

  const actions = new ActionRowBuilder().setComponents(
    new ButtonBuilder()
      .setCustomId('car:take')
      .setLabel('Занять автомобиль')
      .setEmoji('🚗')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!free.length),
    new ButtonBuilder()
      .setCustomId('car:return')
      .setLabel('Освободить автомобиль')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!occupied.length),
  );

  return { embeds: [embed], components: [actions] };
}

function buildPositionsPanel(guild) {
  const positions = guild.positions || {};
  const slotCount = Math.min(50, Math.max(1, positions.slotCount || 10));
  const claims = positions.claims || {};
  const entries = Array.from({ length: slotCount }, (_, index) => {
    const number = index + 1;
    return `**${number}.** ${claims[number] ? `<@${claims[number]}>` : 'свободно'}`;
  });
  const middle = Math.ceil(entries.length / 2);
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📍 Пик позиций')
    .setDescription(
      `Выберите свободную позицию на схеме.\n` +
        `**Занято:** ${Object.keys(claims).length}/${slotCount}`,
    )
    .addFields(
      { name: 'Позиции', value: entries.slice(0, middle).join('\n'), inline: true },
      { name: '\u200b', value: entries.slice(middle).join('\n') || '\u200b', inline: true },
    )
    .setFooter({ text: 'Один участник может занять только одну позицию' });
  if (positions.imageUrl) embed.setImage(positions.imageUrl);

  const rows = [];
  if (slotCount <= 24) {
    const buttons = Array.from({ length: slotCount }, (_, index) => {
      const number = index + 1;
      return new ButtonBuilder()
        .setCustomId(`pos:take:${number}`)
        .setLabel(String(number))
        .setStyle(claims[number] ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(Boolean(claims[number]));
    });
    buttons.push(
      new ButtonBuilder()
        .setCustomId('pos:leave')
        .setLabel('Выход')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Danger),
    );
    for (let index = 0; index < buttons.length; index += 5) {
      rows.push(new ActionRowBuilder().setComponents(buttons.slice(index, index + 5)));
    }
  } else {
    for (let start = 1; start <= slotCount; start += 25) {
      const end = Math.min(start + 24, slotCount);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`pos:select:${start}`)
        .setPlaceholder(`Позиции ${start}–${end}`)
        .addOptions(
          Array.from({ length: end - start + 1 }, (_, index) => {
            const number = start + index;
            return new StringSelectMenuOptionBuilder()
              .setLabel(`Позиция ${number}`)
              .setDescription(claims[number] ? 'Занята' : 'Свободна')
              .setValue(String(number))
              .setEmoji(claims[number] ? '🔴' : '🟢');
          }),
        );
      rows.push(new ActionRowBuilder().setComponents(menu));
    }
    rows.push(
      new ActionRowBuilder().setComponents(
        new ButtonBuilder()
          .setCustomId('pos:leave')
          .setLabel('Выход')
          .setEmoji('🚪')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  const modButton = new ButtonBuilder()
    .setCustomId('pos:mod')
    .setLabel('Модерация')
    .setStyle(ButtonStyle.Secondary);
  const lastRow = rows[rows.length - 1];
  if (lastRow && lastRow.components.length < 5) {
    lastRow.addComponents(modButton);
  } else if (rows.length < 5) {
    rows.push(new ActionRowBuilder().setComponents(modButton));
  }

  return { embeds: [embed], components: rows };
}

function numberedMentions(ids) {
  if (!ids?.length) return '_пока никого_';
  return ids.map((id, index) => `${index + 1}. <@${id}>`).join('\n');
}

function formatGatheringTime(active) {
  if (active?.timeAt) {
    const unix = Math.floor(Number(active.timeAt) / 1000);
    return `<t:${unix}:F> · <t:${unix}:R>`;
  }
  return active?.time || '—';
}

function buildGatheringPanel(guild) {
  const gatherings = guild.gatherings || {};
  const active = gatherings.active && !gatherings.active.closed ? gatherings.active : null;
  const maxMain = active?.maxMain || 0;
  const activeText = active
    ? `**Сейчас открыт**\nВремя: ${formatGatheringTime(active)}\nКонтент: **${active.content || active.title}**\nУчастников: **${active.main?.length || 0}/${maxMain || '∞'}** · Замена: **${active.bench?.length || 0}**`
    : '**Сейчас сбора нет.** Откройте командой `/сбор`.';

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle('📣 Сборы семьи')
    .setDescription(activeText)
    .setFooter({ text: 'Запуск: /сбор' });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().setComponents(
        new ButtonBuilder()
          .setCustomId('gath:close')
          .setLabel('Завершить сбор')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!active),
      ),
    ],
  };
}

function buildGatheringList(guild, options = {}) {
  const gatherings = guild.gatherings || {};
  const active = gatherings.active;
  const closed = typeof options === 'boolean' ? options : Boolean(options.closed || active?.closed);
  const frozen = typeof options === 'object' && Boolean(options.frozen);
  const content = active?.content || active?.title || 'Сбор';
  const main = active?.main || [];
  const bench = active?.bench || [];
  const maxMain = active?.maxMain || 0;

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(closed ? '📋 Сбор завершён' : '📋 Сбор')
    .setDescription(
      `**Время:** ${formatGatheringTime(active)}\n` +
        `**Контент:** ${content}\n` +
        `**Участников:** ${main.length}/${maxMain || '—'}` +
        (closed && active?.threadId ? `\n**Ветка основы:** <#${active.threadId}>` : ''),
    )
    .addFields(
      {
        name: `Основа · ${main.length}/${maxMain || '—'}`,
        value: truncate(numberedMentions(main), 1024),
        inline: true,
      },
      {
        name: `Замена · ${bench.length}`,
        value: truncate(numberedMentions(bench), 1024),
        inline: true,
      },
    );

  const actions = new ActionRowBuilder().setComponents(
    new ButtonBuilder()
      .setCustomId('gath:join:main')
      .setLabel('В основу')
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed || (maxMain > 0 && main.length >= maxMain)),
    new ButtonBuilder()
      .setCustomId('gath:join:bench')
      .setLabel('В замену')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId('gath:leave')
      .setLabel('Выписаться')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId('gath:mod')
      .setLabel('Модерация')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('gath:close')
      .setLabel('Завершить')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed),
  );

  return { embeds: [embed], components: frozen ? [] : [actions] };
}

function buildGatheringsTab(guild) {
  const gatherings = guild.gatherings || {};
  const active = gatherings.active && !gatherings.active.closed ? gatherings.active : null;
  const activeText = active
    ? `**${active.content || active.title}** · основа ${active.main?.length || 0}/${active.maxMain || '—'}`
    : gatherings.active?.closed
      ? `завершён · **${gatherings.active.content || gatherings.active.title}**`
      : 'нет';

  const container = new ContainerBuilder().setAccentColor(0x95a5a6);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Настройка сборов\n` +
          `Запуск: **\`/сбор\`** в нужном канале.\n` +
          `Роль для пинга выбирается прямо в команде.\n\n` +
          `Активный сбор: ${activeText}\n` +
          `Канал VZP-статы: ${channelMention(gatherings.statsChannelId)}\n` +
          `Писать в ветке могут только: ${roleMentions(gatherings.threadRoleIds)}`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:gathclose')
          .setLabel('Завершить сбор')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!active),
        backToHubButton(),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Куда писать стату VZP после завершения сбора**'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:gathstats')
          .setPlaceholder('Канал статистики VZP')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Кто может писать в ветке** (основа только видит, без этих ролей писать нельзя)'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:gaththreadroles')
          .setPlaceholder('Выберите одну или несколько ролей')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    );

  return container;
}

function buildActivityTab(stats, period = 'week', options = {}) {
  const labels = {
    day: 'сегодня',
    week: 'за 7 дней',
    month: 'за 30 дней',
    all: 'за всё время',
  };
  const top = (sorter, line) => {
    const rows = [...stats]
      .filter((item) => sorter.value(item) > 0)
      .sort((a, b) => sorter.value(b) - sorter.value(a))
      .slice(0, 10);
    return rows.length
      ? rows.map((item, index) => `${index + 1}. <@${item.userId}> — ${line(item)}`).join('\n')
      : '_Пока нет данных._';
  };

  const voice = top(
    { value: (item) => item.voiceMs },
    (item) => formatDuration(item.voiceMs),
  );
  const messages = top(
    { value: (item) => item.messages },
    (item) => `${item.messages} сообщ.`,
  );
  const gatherings = top(
    { value: (item) => item.gatheringsMain + item.gatheringsBench },
    (item) =>
      `${item.gatheringsMain + item.gatheringsBench} участ. ` +
      `(основа ${item.gatheringsMain}, замена ${item.gatheringsBench})`,
  );
  const periodId = (value) =>
    options.roleId
      ? `admin:activityrole:${value}:${options.roleId}`
      : `admin:activity:${value}`;

  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## ${options.title || 'Статистика активности'} — ${labels[period] || labels.week}\n\n` +
          `### Голосовая активность\n${voice}\n\n` +
          `### Сообщения\n${messages}\n\n` +
          `### Участие в сборах\n${gatherings}`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId(periodId('day'))
          .setLabel('Сегодня')
          .setStyle(period === 'day' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(periodId('week'))
          .setLabel('7 дней')
          .setStyle(period === 'week' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(periodId('month'))
          .setLabel('30 дней')
          .setStyle(period === 'month' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(periodId('all'))
          .setLabel('Всё время')
          .setStyle(period === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
        backToHubButton(),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Подробная статистика участника или рейтинг выбранной роли**'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('admin:activityuser')
          .setPlaceholder('Выберите участника')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:activityrole')
          .setPlaceholder('Выберите роль')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );

  return container;
}

function buildActivityUserTab(userId, periods) {
  const line = (label, stats) =>
    `**${label}:** голос ${formatDuration(stats.voiceMs)} · сообщения ${stats.messages} · ` +
    `сборы ${stats.gatheringsMain + stats.gatheringsBench} ` +
    `(основа ${stats.gatheringsMain}, замена ${stats.gatheringsBench})`;

  return new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Активность <@${userId}>\n\n` +
          `${line('Сегодня', periods.day)}\n` +
          `${line('7 дней', periods.week)}\n` +
          `${line('30 дней', periods.month)}\n` +
          `${line('Всё время', periods.all)}`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:tab:activity')
          .setLabel('Общая статистика')
          .setStyle(ButtonStyle.Primary),
        backToHubButton(),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('admin:activityuser')
          .setPlaceholder('Выбрать другого участника')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:activityrole')
          .setPlaceholder('Посмотреть статистику роли')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
}

function buildAccessTab(guild) {
  const access = guild.access || {};
  const roles = access.roles || {};
  const selected = Object.hasOwn(ACCESS_ACTIONS, access.selectedAction)
    ? access.selectedAction
    : Object.keys(ACCESS_ACTIONS)[0];
  const summary = Object.entries(ACCESS_ACTIONS)
    .map(([key, label]) => `**${label}:** ${roleMentions(roles[key])}`)
    .join('\n');

  return new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Доступ по ролям\n` +
          `Администраторы сервера всегда имеют полный доступ.\n\n${summary}`,
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Какое действие настроить**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId('admin:accessaction')
          .setPlaceholder('Выберите действие')
          .addOptions(
            Object.entries(ACCESS_ACTIONS).map(([key, label]) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(label)
                .setValue(key)
                .setDefault(key === selected),
            ),
          ),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent(`**Роли для действия «${ACCESS_ACTIONS[selected]}»**`),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:accessroles')
          .setPlaceholder('Выберите разрешённые роли')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    )
    .addActionRowComponents((row) => row.setComponents(backToHubButton()));
}

function buildAutoparkTab(guild) {
  const vehicles = guild.autopark?.vehicles || [];
  const selected =
    vehicles.find((car) => car.id === guild.autopark?.selectedVehicleId) || vehicles[0] || null;
  const list = vehicles.length
    ? vehicles
        .map(
          (car, index) =>
            `${index + 1}. **${car.name}** · \`${car.plate}\` · ` +
            `${car.roleIds?.length ? car.roleIds.map((id) => roleMention(id)).join(' ') : 'без ограничения'} · ` +
            `${car.inUseById ? `<@${car.inUseById}>` : 'свободна'}`,
        )
        .join('\n')
    : '_Машин нет._';

  const container = new ContainerBuilder().setAccentColor(0x3498db);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Настройка автопарка\nОбщее время аренды: **${guild.autopark?.durationMinutes || 60} мин.**\n` +
          `${truncate(list, 2500)}`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId('admin:caradd').setLabel('Добавить').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin:cardelete')
          .setLabel('Удалить')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!vehicles.length),
        new ButtonBuilder()
          .setCustomId('admin:carreset')
          .setLabel('Освободить')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!selected?.inUseById),
        new ButtonBuilder()
          .setCustomId('admin:cartime')
          .setLabel(`Время: ${guild.autopark?.durationMinutes || 60} мин.`)
          .setStyle(ButtonStyle.Secondary),
        backToHubButton(),
      ),
    );

  if (vehicles.length) {
    container
      .addTextDisplayComponents((text) => text.setContent('**Выберите машину для настройки**'))
      .addActionRowComponents((row) =>
        row.setComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin:carpick')
            .setPlaceholder('Машина')
            .addOptions(
              vehicles.slice(0, 25).map((car) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(truncate(car.name, 100))
                  .setDescription(truncate(car.plate, 100))
                  .setValue(car.id)
                  .setDefault(car.id === selected?.id),
              ),
            ),
        ),
      )
      .addTextDisplayComponents((text) =>
        text.setContent(`**Разрешённая роль для ${selected?.name || 'машины'}**`),
      )
      .addActionRowComponents((row) =>
        row.setComponents(
          new RoleSelectMenuBuilder()
            .setCustomId('admin:carrole')
            .setPlaceholder('Выберите разрешённые роли')
            .setMinValues(0)
            .setMaxValues(25),
        ),
      );
  }

  return container;
}

function buildTicketTab(guild) {
  const vzp = guild.types.vzp;
  const rp = guild.types.rp;
  const container = new ContainerBuilder().setAccentColor(0x57f287);

  container
    .addTextDisplayComponents((text) => text.setContent('## Тикеты'))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Отдел настроек заявок: оформление, набор, роли, каналы и вопросы.\n\n` +
          `GIF: ${guild.bannerUrl ? 'установлен' : 'не задан'}\n` +
          `Персонал: ${roleMentions(guild.staffRoleIds)}\n` +
          `Логи ${vzp.label}: ${channelMention(vzp.logChannelId)} · ` +
          `логи ${rp.label}: ${channelMention(rp.logChannelId)}\n` +
          `Повтор после отказа: **${guild.cooldownDays}** дн.\n\n` +
          `**${vzp.label}:** ${statusLabel(vzp.enabled)} · проверка ${channelMention(vzp.reviewChannelId)} · обзвон ${channelMention(vzp.acceptedChannelId)} · форум ${channelMention(vzp.resultForumId)} · роль ${roleMention(vzp.roleId)}\n` +
          `**${rp.label}:** ${statusLabel(rp.enabled)} · проверка ${channelMention(rp.reviewChannelId)} · обзвон ${channelMention(rp.acceptedChannelId)} · форум ${channelMention(rp.resultForumId)} · роль ${roleMention(rp.roleId)}`,
      ),
    )
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId('admin:banner').setLabel('GIF по ссылке').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('admin:text').setLabel('Текст панели').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('admin:cooldown').setLabel('Кулдаун').setStyle(ButtonStyle.Secondary),
        backToHubButton(),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:toggle:vzp')
          .setLabel(vzp.enabled ? `Выключить ${vzp.label}` : `Включить ${vzp.label}`)
          .setStyle(vzp.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin:toggle:rp')
          .setLabel(rp.enabled ? `Выключить ${rp.label}` : `Включить ${rp.label}`)
          .setStyle(rp.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId('admin:page:vzp').setLabel(`Настроить ${vzp.label}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin:page:rp').setLabel(`Настроить ${rp.label}`).setStyle(ButtonStyle.Primary),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Роли персонала** (кто принимает и отклоняет заявки)'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:staff')
          .setPlaceholder('Выберите одну или несколько ролей')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent(`**Канал логов заявок ${vzp.label}**`))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:logchannel:vzp')
          .setPlaceholder(`Логи заявок ${vzp.label}`)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent(`**Канал логов заявок ${rp.label}**`))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:logchannel:rp')
          .setPlaceholder(`Логи заявок ${rp.label}`)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    );

  return container;
}

function buildTypePage(guild, typeKey) {
  const type = guild.types[typeKey];
  const container = new ContainerBuilder().setAccentColor(type.enabled ? 0x57f287 : 0xed4245);

  container
    .addTextDisplayComponents((text) => text.setContent(`## Настройки ${type.label}`))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Статус: **${statusLabel(type.enabled)}**\n` +
          `Канал проверки: ${channelMention(type.reviewChannelId)}\n` +
          `Категория каналов обзвона: ${channelMention(type.acceptedChannelId)}\n` +
          `Форум завершённых тикетов: ${channelMention(type.resultForumId)}\n` +
          `Роль при принятии: ${roleMention(type.roleId)}\n\n` +
          `**Вопросы** (${type.questions.length}/5)\n${questionsPreview(type.questions)}`,
      ),
    )
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId(`admin:togglepage:${typeKey}`)
          .setLabel(type.enabled ? 'Выключить набор' : 'Включить набор')
          .setStyle(type.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`admin:rename:${typeKey}`).setLabel('Название').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`admin:qadd:${typeKey}`)
          .setLabel('Вопрос +')
          .setStyle(ButtonStyle.Success)
          .setDisabled(type.questions.length >= 5),
        new ButtonBuilder()
          .setCustomId(`admin:qdel:${typeKey}`)
          .setLabel('Вопрос −')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(type.questions.length === 0),
        new ButtonBuilder().setCustomId('admin:tab:ticket').setLabel('Назад').setStyle(ButtonStyle.Secondary),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Канал, куда заявки приходят на проверку**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`admin:review:${typeKey}`)
          .setPlaceholder('Канал проверки заявок')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Категория приватных каналов обзвона**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`admin:accepted:${typeKey}`)
          .setPlaceholder('Категория тикетов')
          .addChannelTypes(ChannelType.GuildCategory),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Форум, куда уходят завершённые тикеты**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`admin:resultforum:${typeKey}`)
          .setPlaceholder('Форум результатов')
          .addChannelTypes(ChannelType.GuildForum),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Роль, которая выдаётся при принятии**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`admin:role:${typeKey}`)
          .setPlaceholder('Роль после принятия')
          .setMinValues(0)
          .setMaxValues(1),
      ),
    );

  return container;
}

function buildDeleteQuestionMenu(typeKey, questions) {
  return new ActionRowBuilder().setComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`admin:qdelpick:${typeKey}`)
      .setPlaceholder('Какой вопрос удалить')
      .addOptions(
        questions.map((q, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(`${i + 1}. ${q.label}`, 100))
            .setValue(String(i)),
        ),
      ),
  );
}

function buildApplicationContainer(
  app,
  guild,
  { statusText, reviewerId, reason, staffPing, suppressActions = false } = {},
) {
  const type = guild.types[app.type];
  const color =
    app.status === 'accepted' ? 0x57f287 : app.status === 'rejected' ? 0xed4245 : 0xfee75c;

  let answers = (app.answers || [])
    .map((item, i) => `**${i + 1}. ${item.q}:** ${item.a || '—'}`)
    .join('\n');
  if (answers.length > 3500) answers = `${answers.slice(0, 3499)}…`;

  const extra = [];
  if (staffPing) extra.push(staffPing);
  if (reviewerId) extra.push(`Рассмотрел: <@${reviewerId}>`);
  if (reason) extra.push(`Причина: ${reason}`);

  const container = new ContainerBuilder().setAccentColor(color);
  container.addTextDisplayComponents((text) =>
    text.setContent(
      `## Тикет ${String(app.number).padStart(4, '0')} · ${type?.label || app.type.toUpperCase()}\n` +
        `От: <@${app.userId}> · Статус: **${statusText || 'На рассмотрении'}** · ` +
        `<t:${Math.floor(app.createdAt / 1000)}:R>` +
        (extra.length ? `\n${extra.join('\n')}` : '') +
        `\n${answers || '_Ответов нет_'}`,
    ),
  );

  if (app.status === 'pending' && !suppressActions) {
    container.addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId(`rev:call:${app.id}`)
          .setLabel('Принять на обзвон')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`rev:no:${app.id}`).setLabel('Отказать').setStyle(ButtonStyle.Danger),
      ),
    );
  } else if (app.status === 'interview' && !suppressActions) {
    container.addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId(`rev:ok:${app.id}`).setLabel('Принять').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rev:no:${app.id}`).setLabel('Отказать').setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`rev:invite:${app.id}`)
          .setLabel('Вызвать на обзвон')
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  return container;
}

function formatAfkDuration(ms) {
  const totalMin = Math.max(1, Math.round(Math.max(0, ms) / 60_000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours && minutes) return `${hours}ч ${minutes}м`;
  if (hours) return `${hours}ч`;
  return `${minutes}м`;
}

function activeAfkEntries(guild) {
  const now = Date.now();
  return (guild.afk?.entries || []).filter((entry) => entry.endsAt > now);
}

function buildAfkPanel(guild) {
  const count = activeAfkEntries(guild).length;
  const container = new ContainerBuilder().setAccentColor(0x000000);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## AFK\n` +
          `Уйдите в AFK с указанием причины и времени.\n` +
          `По истечении срока вы автоматически пропадёте из списка.\n\n` +
          `Сейчас в AFK: **${count}**`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId('afk:join').setLabel('Уйти в AFK').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('afk:leave').setLabel('Выйти с AFK').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('afk:list').setLabel('Список AFK').setStyle(ButtonStyle.Primary),
      ),
    );
  return container;
}

function buildAfkLog(entry) {
  const until = Math.floor(entry.endsAt / 1000);
  const reason = String(entry.reason || 'без причины').replace(/\s+/g, ' ');
  const container = new ContainerBuilder().setAccentColor(0x000000);
  container.addTextDisplayComponents((text) =>
    text.setContent(
      `## AFK\n` +
        `**Кто:** <@${entry.userId}>\n` +
        `**Причина:** ${reason}\n` +
        `**На сколько:** ${entry.durationLabel || formatAfkDuration(entry.endsAt - entry.startedAt)}\n` +
        `**До:** <t:${until}:t> · <t:${until}:R>`,
    ),
  );
  return container;
}

function buildAfkList(guild) {
  const entries = activeAfkEntries(guild);
  const list = entries.length
    ? entries
        .map((entry, index) => {
          const until = Math.floor(entry.endsAt / 1000);
          const reason = String(entry.reason || 'без причины').replace(/\s+/g, ' ');
          return `${index + 1}. <@${entry.userId}> — ${reason} · **${entry.durationLabel || formatAfkDuration(entry.endsAt - entry.startedAt)}** · <t:${until}:R>`;
        })
        .join('\n')
    : '_Сейчас никого нет в AFK._';

  const container = new ContainerBuilder().setAccentColor(0x000000);
  container.addTextDisplayComponents((text) => text.setContent(`## Список AFK\n${truncate(list, 3800)}`));
  return container;
}

module.exports = {
  v2Flags,
  buildPublicPanel,
  buildAdminHub,
  buildSummary,
  buildPanelsTab,
  buildLogsTab,
  buildAutoparkPanel,
  buildAutoparkTab,
  buildPositionsPanel,
  buildGatheringPanel,
  buildGatheringList,
  buildGatheringsTab,
  buildActivityTab,
  buildActivityUserTab,
  buildAccessTab,
  buildSecurityTab,
  buildTicketTab,
  buildTypePage,
  buildDeleteQuestionMenu,
  buildApplicationContainer,
  buildAfkPanel,
  buildAfkList,
  buildAfkLog,
  formatAfkDuration,
};
