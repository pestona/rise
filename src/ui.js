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
const { ACCESS_ACTIONS, fillPlaceholders, formatHexColor, isHttpUrl, statusLabel, truncate } = require('./util');

function v2Flags(ephemeral = false) {
  return ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2;
}

function addBanner(container, url) {
  if (!url) return container;
  return container.addMediaGalleryComponents((gallery) =>
    gallery.addItems((item) => item.setURL(url).setDescription('Баннер заявок')),
  );
}

function addImages(container, urls, description) {
  const items = [...new Set((urls || []).filter((url) => isHttpUrl(url)))].slice(0, 3);
  if (!items.length) return container;
  return container.addMediaGalleryComponents((gallery) => {
    for (const url of items) {
      gallery.addItems((item) => item.setURL(url).setDescription(description || 'Фото'));
    }
    return gallery;
  });
}

function customPanelList(guild) {
  return [...(guild.customPanels?.items || [])];
}

function selectedCustomPanel(guild) {
  const items = customPanelList(guild);
  return items.find((item) => item.id === guild.customPanels?.selectedId) || items[0] || null;
}

function customImagePosition(panel) {
  return panel?.imagePosition === 'bottom' ? 'bottom' : 'top';
}

function customMentionText(panel) {
  return (panel?.mentionRoleIds || []).filter(Boolean).map((id) => `<@&${id}>`).join(' ');
}

function fillCustomPanelBody(panel) {
  const mentions = customMentionText(panel);
  return String(panel?.body || '')
    .replace(/\{роли\}/gi, mentions)
    .replace(/\{role\}/gi, mentions)
    .trim();
}

function buildCustomPanel(panel) {
  const color = Number.isInteger(panel?.accentColor) ? panel.accentColor : 0x111111;
  const title = String(panel?.title || panel?.name || 'Панель').trim() || 'Панель';
  const body = fillCustomPanelBody(panel);
  const container = new ContainerBuilder().setAccentColor(color);
  const addText = () =>
    container.addTextDisplayComponents((text) =>
      text.setContent(truncate(body ? `## ${title}\n${body}` : `## ${title}`, 3900)),
    );
  if (customImagePosition(panel) === 'bottom') {
    addText();
    addImages(container, panel?.imageUrls, title);
  } else {
    addImages(container, panel?.imageUrls, title);
    addText();
  }
  return container;
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
    description: 'Уход в AFK или отпуск с причиной и временем',
  },
  {
    key: 'nicks',
    label: 'Ники и статики',
    description: 'Привязка игрового ника и статика к Discord',
  },
  {
    key: 'shop',
    label: 'Магазин',
    description: 'Баллы, товары и РП-отчёты',
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
        new ButtonBuilder()
          .setCustomId('admin:tab:nicks')
          .setLabel('Ники')
          .setEmoji('🏷️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:custom')
          .setLabel('Custom-panel')
          .setEmoji('🖼️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:afk')
          .setLabel('AFK')
          .setEmoji('💤')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:shop')
          .setLabel('Магазин')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Primary),
      ),
    );

  return container;
}

function buildSummary(guild) {
  const panelNames = {
    tickets: 'Заявки в семью',
    autopark: 'Автопарк',
    afk: 'AFK',
    nicks: 'Ники и статики',
    gatherings: 'Сборы',
    shop: 'Магазин',
  };
  const customNames = Object.fromEntries(
    customPanelList(guild).map((item) => [`custom:${item.id}`, item.name || 'Custom-panel']),
  );
  const published = (guild.panels || []).length
    ? guild.panels
        .map((panel) => {
          const name = panelNames[panel.key] || customNames[panel.key] || panel.key;
          return `• ${name}: ${channelMention(panel.channelId)}`;
        })
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
    `Роли выходов: ${watchedRoles}\n\n` +
    `### AFK / Отпуск\n` +
    `Логи: ${channelMention(guild.afk?.logChannelId)}\n` +
    `Роль AFK: ${roleMention(guild.afk?.restRoleId)}\n` +
    `Роль отпуска: ${roleMention(guild.afk?.vacationRoleId)}\n` +
    `Вайтлист: ${roleMentions(guild.afk?.keepRoleIds)}\n\n` +
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
    .addActionRowComponents((row) => row.setComponents(backToHubButton()));

  return container;
}

function buildAfkTab(guild) {
  const entries = activeAfkEntries(guild);
  const afkEntries = entries.filter((entry) => afkKind(entry) === 'afk');
  const vacationEntries = entries.filter((entry) => afkKind(entry) === 'vacation');
  const published = (guild.panels || [])
    .filter((item) => item.key === 'afk')
    .map((item) => channelMention(item.channelId));
  const publishedText = published.length ? published.join(', ') : 'ещё не опубликована';

  const container = new ContainerBuilder().setAccentColor(0x000000);
  container
    .addTextDisplayComponents((text) => text.setContent('## AFK / Отпуск'))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `При уходе бот снимает роли и выдаёт одну роль отдыха или отпуска. Вайтлист не трогает. По истечении времени роли возвращаются.\n\n` +
          `Роль AFK: ${roleMention(guild.afk?.restRoleId)}\n` +
          `Роль отпуска: ${roleMention(guild.afk?.vacationRoleId)}\n` +
          `Вайтлист: ${roleMentions(guild.afk?.keepRoleIds)}\n` +
          `Логи AFK: ${channelMention(guild.afk?.logChannelId)}\n` +
          `Панель: ${publishedText}\n\n` +
          truncate(
            `${formatAfkSection('Сейчас в AFK', afkEntries)}\n\n${formatAfkSection('Сейчас в отпуске', vacationEntries)}`,
            1800,
          ),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Роль AFK / отдыха** (выдаётся вместо снятых ролей)'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:afkset:rest')
          .setPlaceholder('Роль AFK')
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Роль отпуска** (выдаётся вместо снятых ролей)'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:afkset:vacation')
          .setPlaceholder('Роль отпуска')
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Вайтлист** — эти роли бот не снимает на AFK/отпуске'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:afkset:keep')
          .setPlaceholder('Роли, которые оставить')
          .setMinValues(0)
          .setMaxValues(25),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Канал логов AFK**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:afkchan:log')
          .setPlaceholder('Канал логов AFK')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Опубликовать панель AFK**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:afksend')
          .setPlaceholder('Канал панели AFK')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1),
      ),
    )
    .addActionRowComponents((row) => row.setComponents(backToHubButton()));

  return container;
}

function buildCustomPanelsTab(guild) {
  const items = customPanelList(guild);
  const selected = selectedCustomPanel(guild);
  const published = selected
    ? (guild.panels || [])
        .filter((item) => item.key === `custom:${selected.id}`)
        .map((item) => channelMention(item.channelId))
    : [];
  const photos = selected?.imageUrls?.filter(Boolean).length || 0;
  const photoPlace = customImagePosition(selected) === 'bottom' ? 'внизу' : 'вверху';
  const preview = selected
    ? `Сейчас: **${selected.name}**\n` +
      `Заголовок: **${selected.title || selected.name}**\n` +
      `Цвет: \`${formatHexColor(selected.accentColor)}\` · фото: **${photos}** (${photoPlace})\n` +
      `Тег ролей: ${roleMentions(selected.mentionRoleIds)}\n` +
      `Опубликована: ${published.length ? published.join(', ') : 'ещё нет'}\n\n` +
      truncate(String(selected.body || '_Текст ещё не задан._'), 900)
    : 'Панелей ещё нет — нажми **Создать**.';

  const container = new ContainerBuilder().setAccentColor(
    Number.isInteger(selected?.accentColor) ? selected.accentColor : 0x9b59b6,
  );
  container
    .addTextDisplayComponents((text) => text.setContent('## Custom-panel'))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Свои панели: фото, текст и цвет. Чтобы тегнуть роль — выбери её ниже и напиши в тексте \`{роли}\`.\n\n${preview}`,
      ),
    );

  if (items.length) {
    container
      .addTextDisplayComponents((text) => text.setContent('**Какую панель править**'))
      .addActionRowComponents((row) =>
        row.setComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin:cpick')
            .setPlaceholder('Выберите панель')
            .addOptions(
              items.slice(0, 25).map((item) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(truncate(item.name || 'Панель', 100))
                  .setDescription(truncate(item.title || 'без заголовка', 100))
                  .setValue(item.id)
                  .setDefault(item.id === selected?.id),
              ),
            ),
        ),
      );
  }

  container
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:cadd')
          .setLabel('Создать')
          .setStyle(ButtonStyle.Success)
          .setDisabled(items.length >= 25),
        new ButtonBuilder()
          .setCustomId('admin:ctext')
          .setLabel('Текст')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!selected),
        new ButtonBuilder()
          .setCustomId('admin:cphoto')
          .setLabel('Фото')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!selected),
        new ButtonBuilder()
          .setCustomId('admin:ccolor')
          .setLabel('Цвет')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!selected),
        new ButtonBuilder()
          .setCustomId('admin:cdel')
          .setLabel('Удалить')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!selected),
      ),
    );

  if (selected) {
    const photoBottom = customImagePosition(selected) === 'bottom';
    container
      .addActionRowComponents((row) =>
        row.setComponents(
          new ButtonBuilder()
            .setCustomId('admin:cpos:top')
            .setLabel('Фото сверху')
            .setStyle(photoBottom ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin:cpos:bottom')
          .setLabel('Фото снизу')
          .setStyle(photoBottom ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
      )
      .addTextDisplayComponents((text) =>
        text.setContent('**Какие роли тегать** — в тексте поставь `{роли}`'),
      )
      .addActionRowComponents((row) =>
        row.setComponents(
          new RoleSelectMenuBuilder()
            .setCustomId('admin:cmentions')
            .setPlaceholder('Роли для тега')
            .setMinValues(0)
            .setMaxValues(25),
        ),
      )
      .addTextDisplayComponents((text) => text.setContent('**Куда отправить эту панель**'))
      .addActionRowComponents((row) =>
        row.setComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('admin:csend')
            .setPlaceholder('Выберите канал')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setMinValues(1)
            .setMaxValues(1),
        ),
      );
  }

  container.addActionRowComponents((row) => row.setComponents(backToHubButton()));
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

const TIER_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

function gatheringTier(member, tierRoleIds) {
  if (!member || !tierRoleIds?.length) return 0;
  let best = 0;
  for (let index = 0; index < tierRoleIds.length; index += 1) {
    if (!member.roles.cache.has(tierRoleIds[index])) continue;
    const tier = index + 1;
    if (!best || tier < best) best = tier;
  }
  return best;
}

function sortGatheringIds(ids, discordGuild, tierRoleIds) {
  return [...ids].sort((left, right) => {
    const leftTier = gatheringTier(discordGuild?.members?.cache.get(left), tierRoleIds) || 99;
    const rightTier = gatheringTier(discordGuild?.members?.cache.get(right), tierRoleIds) || 99;
    if (leftTier !== rightTier) return leftTier - rightTier;
    return ids.indexOf(left) - ids.indexOf(right);
  });
}

function numberedMentions(ids, discordGuild, tierRoleIds) {
  if (!ids?.length) return '_пока никого_';
  return sortGatheringIds(ids, discordGuild, tierRoleIds)
    .map((id, index) => {
      const tier = gatheringTier(discordGuild?.members?.cache.get(id), tierRoleIds);
      const medal = TIER_MEDALS[tier];
      return `${index + 1}. ${medal ? `${medal} ` : ''}<@${id}>`;
    })
    .join('\n');
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
  const discordGuild = options.discordGuild || null;
  const tierRoleIds = gatherings.tierRoleIds || [];

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(closed ? '📋 Сбор завершён' : '📋 Сбор')
    .setDescription(
      `**Время:** ${formatGatheringTime(active)}\n` +
        `**Контент:** ${content}\n` +
        `**Участников:** ${main.length}/${maxMain || '—'}` +
        (closed && active?.threadId
          ? `\n**Ветка основы:** <#${active.threadId}>` +
            (active.threadDeleteAt
              ? ` · в архив <t:${Math.floor(active.threadDeleteAt / 1000)}:R>`
              : '')
          : ''),
    )
    .addFields(
      {
        name: `Основа · ${main.length}/${maxMain || '—'}`,
        value: truncate(numberedMentions(main, discordGuild, tierRoleIds), 1024),
        inline: true,
      },
      {
        name: `Замена · ${bench.length}`,
        value: truncate(numberedMentions(bench, discordGuild, tierRoleIds), 1024),
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
          `Архив веток: ${channelMention(gatherings.archiveChannelId)}\n` +
          `Когда матч ВЗП заканчивается, бот сам ищет сбор att/deff и отправляет стату.\n` +
          `Писать в ветке могут только: ${roleMentions(gatherings.threadRoleIds)}\n` +
          `Тиры в списке: ${roleMentions(gatherings.tierRoleIds) || 'не выбраны'} (🥇 → 🥈 → 🥉 → без тира)\n\n` +
          `Тест статы: кнопка ниже → число → матч.`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:gathclose')
          .setLabel('Завершить сбор')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!active),
        new ButtonBuilder()
          .setCustomId('admin:vzpstats')
          .setLabel('Тест статы VZP')
          .setStyle(ButtonStyle.Primary),
        backToHubButton(),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Куда писать стату VZP**'),
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
      text.setContent('**Куда архивировать ветки сборов** (форум: пост на каждый сбор, потом ветка удаляется)'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:gatharchive')
          .setPlaceholder('Форум архива веток')
          .addChannelTypes(ChannelType.GuildForum)
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
    )
    .addTextDisplayComponents((text) =>
      text.setContent('**Роли тиров** (выше роль = тир 1 🥇, дальше 🥈 и 🥉). Без тира — внизу списка.'),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('admin:gathtiers')
          .setPlaceholder('Тир 1, тир 2, тир 3')
          .setMinValues(0)
          .setMaxValues(3),
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
          `Администраторы сервера всегда имеют полный доступ.\n` +
          `Для каждого действия можно выбрать несколько ролей.\n\n${summary}`,
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
          .setPlaceholder('Можно выбрать несколько ролей')
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
          `Семья: **${guild.familyName || 'Trapaholic'}**\n` +
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
        new ButtonBuilder().setCustomId('admin:family').setLabel('Семья').setStyle(ButtonStyle.Secondary),
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

function afkKind(entry) {
  return entry?.kind === 'vacation' ? 'vacation' : 'afk';
}

function afkKindLabel(kind) {
  return kind === 'vacation' ? 'Отпуск' : 'AFK';
}

function activeAfkEntries(guild) {
  const now = Date.now();
  return (guild.afk?.entries || []).filter((entry) => entry.endsAt > now);
}

function formatAfkLine(entry, index) {
  const until = Math.floor(entry.endsAt / 1000);
  const reason = String(entry.reason || 'без причины').replace(/\s+/g, ' ');
  return `${index + 1}. <@${entry.userId}> — ${reason} · **${entry.durationLabel || formatAfkDuration(entry.endsAt - entry.startedAt)}** · <t:${until}:R>`;
}

function formatAfkSection(title, entries) {
  if (!entries.length) return `## ${title}\n_Никого нет._`;
  return `## ${title}\n${entries.map(formatAfkLine).join('\n')}`;
}

function buildAfkPanel(guild) {
  const entries = activeAfkEntries(guild);
  const afkEntries = entries.filter((entry) => afkKind(entry) === 'afk');
  const vacationEntries = entries.filter((entry) => afkKind(entry) === 'vacation');
  const intro =
    `## AFK / Отпуск\n` +
    `Уйдите в AFK или отпуск с указанием причины и времени.\n` +
    `По истечении срока вы автоматически пропадёте из списка.\n\n`;
  const list = `${formatAfkSection('AFK', afkEntries)}\n\n${formatAfkSection('Отпуск', vacationEntries)}`;
  const container = new ContainerBuilder().setAccentColor(0x000000);
  container
    .addTextDisplayComponents((text) => text.setContent(truncate(`${intro}${list}`, 3900)))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId('afk:join:afk').setLabel('Уйти в AFK').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('afk:join:vacation').setLabel('Уйти в отпуск').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('afk:leave').setLabel('Выйти').setStyle(ButtonStyle.Secondary),
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
      `## ${afkKindLabel(afkKind(entry))}\n` +
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
  const afkEntries = entries.filter((entry) => afkKind(entry) === 'afk');
  const vacationEntries = entries.filter((entry) => afkKind(entry) === 'vacation');
  const list = `${formatAfkSection('AFK', afkEntries)}\n\n${formatAfkSection('Отпуск', vacationEntries)}`;
  const container = new ContainerBuilder().setAccentColor(0x000000);
  container.addTextDisplayComponents((text) => text.setContent(truncate(list, 3800)));
  return container;
}

function nickEntries(guild) {
  return [...(guild.nicks?.entries || [])].sort((a, b) =>
    String(a.nick || '').localeCompare(String(b.nick || ''), 'ru', { sensitivity: 'base' }),
  );
}

function formatNickDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

function nickLine(entry, index) {
  return `${index + 1}. <@${entry.userId}> — **${entry.nick} | ${entry.staticId}** · ${formatNickDate(entry.updatedAt)}`;
}

function buildNicksPanel(guild) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Ники и статики\n` +
          `Нажми кнопку и введи данные в формате **Ник | статик**.\n` +
          `Запись привяжется к твоему Discord ID.`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('nicks:set')
          .setLabel('Добавить / изменить')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('nicks:delete')
          .setLabel('Удалить мой ник')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  return container;
}

function buildNickPickMenu(entries, mode, page) {
  const start = page * 25;
  return new StringSelectMenuBuilder()
    .setCustomId(`admin:nickpick:${mode}`)
    .setPlaceholder(mode === 'delete' ? 'Кого удалить?' : 'Кого изменить?')
    .addOptions(
      entries.slice(start, start + 25).map((entry) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${entry.nick} | ${entry.staticId}`, 100))
          .setDescription(`Discord ID: ${entry.userId}`)
          .setValue(entry.userId),
      ),
    );
}

function nickPageButtons(mode, page, totalPages) {
  return [
    new ButtonBuilder()
      .setCustomId(`admin:nickpage:${mode}:${Math.max(0, page - 1)}`)
      .setLabel('Назад')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`admin:nickpage:${mode}:${page + 1}`)
      .setLabel('Дальше')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page + 1 >= totalPages),
    new ButtonBuilder().setCustomId('admin:tab:nicks').setLabel('К списку').setStyle(ButtonStyle.Secondary),
  ];
}

function buildNicksTab(guild, options = {}) {
  const mode = options.mode || 'list';
  const entries = nickEntries(guild);
  const pageSize = mode === 'list' ? 15 : 25;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(Math.max(0, options.page || 0), totalPages - 1);
  const start = page * pageSize;
  const shown = entries.slice(start, start + pageSize);
  const list = shown.length
    ? shown.map((entry, index) => nickLine(entry, start + index)).join('\n')
    : '_Ников ещё нет._';

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Ники и статики\n` +
          `Всего записей: **${entries.length}**\n` +
          `Формат: **Ник | статик**\n\n` +
          truncate(list, 3500),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:nickadd')
          .setLabel('Добавить')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin:nickedit')
          .setLabel('Изменить')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!entries.length),
        new ButtonBuilder()
          .setCustomId('admin:nickdel')
          .setLabel('Удалить')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!entries.length),
        backToHubButton(),
      ),
    );

  if (mode === 'add') {
    container
      .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents((text) => text.setContent('**Добавить ник пользователю**'))
      .addActionRowComponents((row) =>
        row.setComponents(
          new UserSelectMenuBuilder()
            .setCustomId('admin:nickuser')
            .setPlaceholder('Выберите участника')
            .setMinValues(1)
            .setMaxValues(1),
        ),
      );
  } else if ((mode === 'edit' || mode === 'delete') && entries.length) {
    container
      .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents((text) =>
        text.setContent(mode === 'delete' ? '**Удалить запись**' : '**Изменить запись**'),
      )
      .addActionRowComponents((row) => row.setComponents(buildNickPickMenu(entries, mode, page)))
      .addActionRowComponents((row) => row.setComponents(...nickPageButtons(mode, page, totalPages)));
  } else if (mode === 'list' && totalPages > 1) {
    container.addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId(`admin:nickpage:list:${Math.max(0, page - 1)}`)
          .setLabel('Назад')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId(`admin:nickpage:list:${page + 1}`)
          .setLabel('Дальше')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page + 1 >= totalPages),
      ),
    );
  }

  return container;
}

function shopReportTypes(shop) {
  return [...(shop?.reportTypes || [])].slice(0, 25);
}

function shopStockLabel(item) {
  if (item?.stock == null || item.stock === '') return 'без лимита';
  const stock = Math.max(0, Math.floor(Number(item.stock) || 0));
  return stock ? `осталось ${stock}` : 'нет в наличии';
}

function buildShopPanel(guild) {
  const shop = guild.shop || {};
  const items = (shop.items || []).slice(0, 25);
  const buyable = items.some((item) => item.enabled !== false && (item.stock == null || Number(item.stock) > 0));
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  addBanner(container, shop.bannerUrl);
  if (items.length) {
    container.addActionRowComponents((row) =>
      row.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId('shop:pick')
          .setPlaceholder('Выбрать товар')
          .addOptions(
            items.map((item) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(truncate(`${item.enabled === false ? '[выкл] ' : ''}${item.name || 'Товар'}`, 100))
                .setDescription(
                  truncate(
                    `${item.price} баллов · ${shopStockLabel(item)}${item.description ? ` · ${item.description}` : ''}`,
                    100,
                  ),
                )
                .setValue(item.id),
            ),
          ),
      ),
    );
  }
  container.addActionRowComponents((row) =>
    row.setComponents(
      new ButtonBuilder().setCustomId('shop:balance').setLabel('Баланс').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('shop:report').setLabel('РП отчёты').setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('shop:buy')
        .setLabel('Купить')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!buyable),
    ),
  );
  return container;
}

function buildShopBalance(guild, balance) {
  const shop = guild.shop || {};
  const voice = Number(shop.voiceMinutesPerPoint || 0);
  const types = shopReportTypes(shop);
  const list = types.length
    ? types.map((type) => `${type.emoji || '•'} ${type.name} — +${type.points}`).join('\n')
    : 'РП-отчёты не настроены.';
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  container.addTextDisplayComponents((text) =>
    text.setContent(
      `## Баланс\n` +
        `У тебя **${balance}** баллов.\n\n` +
        (voice > 0
          ? `Голосовые: 1 балл за **${voice}** мин. в войсе.` +
            (Number(shop.tagVoiceMultiplier || 1) > 1
              ? ` С тегом сервера: **x${shop.tagVoiceMultiplier}**.\n\n`
              : '\n\n')
          : 'Голосовые баллы выключены.\n\n') +
        `**РП-отчёты**\n${truncate(list, 1500)}`,
    ),
  );
  return container;
}

function buildShopReportCatalog(guild) {
  const types = shopReportTypes(guild.shop);
  const list = types.length
    ? types.map((type) => `${type.emoji || '•'} **${type.name}** — +${type.points} балл${type.points === 1 ? '' : type.points < 5 ? 'а' : 'ов'}`).join('\n')
    : '_Типы мероприятий не настроены._';
  const container = new ContainerBuilder().setAccentColor(0x2b2d31);
  container.addTextDisplayComponents((text) =>
    text.setContent(
      `## Каталог РП-мероприятий\n${truncate(list, 1800)}\n\n` +
        (types.length ? 'Выберите тип мероприятия ниже, затем укажите ссылку на скриншот.' : ''),
    ),
  );
  for (let i = 0; i < types.length; i += 3) {
    const chunk = types.slice(i, i + 3);
    container.addActionRowComponents((row) =>
      row.setComponents(
        chunk.map((type) => {
          const button = new ButtonBuilder()
            .setCustomId(`shop:rtype:${type.id}`)
            .setLabel(truncate(type.name, 80))
            .setStyle(ButtonStyle.Secondary);
          if (type.emoji) button.setEmoji(type.emoji);
          return button;
        }),
      ),
    );
  }
  return container;
}

function buildShopReportReview(report, guild, extra = {}) {
  const ping = extra.staffPing ? `${roleMentions(guild.staffRoleIds)} новый РП-отчёт\n` : '';
  const status =
    report.status === 'accepted' ? 'Принят' : report.status === 'rejected' ? 'Отклонён' : 'На проверке';
  const container = new ContainerBuilder().setAccentColor(
    report.status === 'accepted' ? 0x57f287 : report.status === 'rejected' ? 0xed4245 : 0xf1c40f,
  );
  container.addTextDisplayComponents((text) =>
    text.setContent(
      truncate(
        `${ping}## РП-отчёт${report.typeName ? ` · ${report.typeName}` : ''}\n` +
          `**Кто:** <@${report.userId}>\n` +
          `**Статус:** ${status}\n` +
          (report.typeName ? `**Тип:** ${report.typeName}\n` : '') +
          (report.imageUrl ? `**Скрин:** ${report.imageUrl}\n` : '') +
          (report.comment ? `**Подпись:** ${report.comment}\n` : '') +
          (report.reviewerId ? `**Проверил:** <@${report.reviewerId}>\n` : '') +
          (report.status === 'accepted' && report.points ? `**Баллы:** +${report.points}` : report.points ? `**Баллы при принятии:** +${report.points}` : ''),
        3900,
      ),
    ),
  );
  if (!extra.reviewed && report.status === 'pending') {
    container.addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId(`shoprev:ok:${report.id}`).setLabel('Принять').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`shoprev:no:${report.id}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return container;
}

function formatShopDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function buildShopPurchaseReview(purchase, guild, extra = {}) {
  const ping = extra.staffPing ? `${roleMentions(guild.staffRoleIds)} новая покупка\n` : '';
  const status =
    purchase.status === 'accepted' ? 'Принята' : purchase.status === 'rejected' ? 'Отклонена' : 'На проверке';
  const container = new ContainerBuilder().setAccentColor(
    purchase.status === 'accepted' ? 0x57f287 : purchase.status === 'rejected' ? 0xed4245 : 0xf1c40f,
  );
  container.addTextDisplayComponents((text) =>
    text.setContent(
      truncate(
        `${ping}## Покупка · ${purchase.itemName || 'Товар'}\n` +
          `**Кто:** <@${purchase.userId}>\n` +
          `**Статус:** ${status}\n` +
          `**Товар:** ${purchase.itemName}\n` +
          `**Цена:** ${purchase.price} баллов\n` +
          (purchase.roleId ? `**Роль:** <@&${purchase.roleId}>\n` : '') +
          (purchase.reviewerId ? `**Проверил:** <@${purchase.reviewerId}>` : ''),
        3900,
      ),
    ),
  );
  if (!extra.reviewed && purchase.status === 'pending') {
    container.addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId(`shopbuy:ok:${purchase.id}`).setLabel('Принять').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`shopbuy:no:${purchase.id}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return container;
}

function buildShopReportNotice(kind, options = {}) {
  const accepted = kind === 'accepted';
  const typeName = options.typeName || 'РП-отчёт';
  const container = new ContainerBuilder().setAccentColor(accepted ? 0x57f287 : 0xed4245);
  container.addTextDisplayComponents((text) =>
    text.setContent(
      `## ${typeName} • ${accepted ? 'Одобрен' : 'Отклонён'}\n` +
        (options.imageUrl ? `**Скрин:** [Открыть скрин](${options.imageUrl})\n` : '') +
        `**Дата:** ${formatShopDateTime(options.at)}`,
    ),
  );
  return container;
}

function backToShopButton() {
  return new ButtonBuilder().setCustomId('admin:tab:shop').setLabel('К магазину').setStyle(ButtonStyle.Secondary);
}

function shopItemList(items, selected) {
  if (!items.length) return '_Товаров нет._';
  return items
    .map(
      (item) =>
        `${item.id === selected?.id ? '•' : '·'} **${item.name}** — **${item.price}** б. · ${shopStockLabel(item)} · ${item.enabled === false ? 'выкл' : 'вкл'}` +
        `${item.roleId ? ` · ${roleMention(item.roleId)}` : ''}`,
    )
    .join('\n');
}

function buildShopHome(shop, items) {
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  container
    .addTextDisplayComponents((text) => text.setContent('## Магазин'))
    .addTextDisplayComponents((text) =>
      text.setContent(
        `Фото панели: **${shop.bannerUrl ? 'стоит' : 'нет'}**\n` +
          `Начисление: **${shopReportTypes(shop).length}** типов РП · **${shop.voiceMinutesPerPoint ?? 60} мин.** = 1 балл` +
          (Number(shop.tagVoiceMultiplier || 1) > 1 ? ` · тег **x${shop.tagVoiceMultiplier}**` : '') +
          `\n` +
          `Товары: **${items.length}**\n` +
          `Проверка отчётов: ${channelMention(shop.reviewChannelId)}\n` +
          `Заявки на покупку: ${channelMention(shop.purchaseChannelId || shop.reviewChannelId)}`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:tab:shop:photo')
          .setLabel('Фото панели')
          .setEmoji('🖼️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:shop:rates')
          .setLabel('Начисление')
          .setEmoji('📈')
          .setStyle(ButtonStyle.Primary),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:tab:shop:items')
          .setLabel('Товары')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:tab:shop:points')
          .setLabel('Баллы')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Primary),
        backToHubButton(),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Опубликовать панель магазина**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:shopsend')
          .setPlaceholder('Канал панели магазина')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
  return container;
}

function buildShopPhoto(shop) {
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  addBanner(container, shop.bannerUrl);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Магазин · Фото панели\n` +
          (shop.bannerUrl ? 'Сейчас фото стоит. Можно заменить или убрать.' : 'Фото ещё не задано.'),
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:shopbanner')
          .setLabel(shop.bannerUrl ? 'Заменить фото' : 'Поставить фото')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:shopbanneroff')
          .setLabel('Убрать фото')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!shop.bannerUrl),
        backToShopButton(),
      ),
    );
  return container;
}

function buildShopRates(shop) {
  const voice = Number(shop.voiceMinutesPerPoint ?? 60);
  const types = shopReportTypes(shop);
  const selected = types.find((type) => type.id === shop.selectedReportTypeId) || types[0] || null;
  const list = types.length
    ? types
        .map(
          (type) =>
            `${type.id === selected?.id ? '•' : '·'} ${type.emoji || ''} **${type.name}** — +${type.points}`,
        )
        .join('\n')
    : '_Типов РП нет._';
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Магазин · Начисление\n` +
          `Голосовые: ${voice > 0 ? `**1 балл = ${voice} мин.**` : '**выкл.**'}\n` +
          `Тег сервера: **x${shop.tagVoiceMultiplier ?? 1.5}**\n` +
          `Канал проверки: ${channelMention(shop.reviewChannelId)}\n\n` +
          `**РП-мероприятия**\n${truncate(list, 1500)}`,
      ),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder().setCustomId('admin:shoprate').setLabel('Голосовые').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('admin:shoprtype')
          .setLabel('Тип +')
          .setStyle(ButtonStyle.Success)
          .setDisabled(types.length >= 25),
        new ButtonBuilder()
          .setCustomId('admin:shopredit')
          .setLabel('Изменить')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!selected),
        new ButtonBuilder()
          .setCustomId('admin:shoprtypedel')
          .setLabel('Тип −')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!selected),
        backToShopButton(),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Канал проверки РП-отчётов**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:shopreview')
          .setPlaceholder('Куда приходят отчёты')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    );

  if (types.length) {
    container
      .addTextDisplayComponents((text) => text.setContent('**Какой тип править**'))
      .addActionRowComponents((row) =>
        row.setComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin:shoprtypepick')
            .setPlaceholder('Тип РП')
            .addOptions(
              types.map((type) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(truncate(`${type.emoji ? `${type.emoji} ` : ''}${type.name}`, 100))
                  .setDescription(truncate(`+${type.points} баллов`, 100))
                  .setValue(type.id)
                  .setDefault(type.id === selected?.id),
              ),
            ),
        ),
      );
  }
  return container;
}

function buildShopItems(shop, items, selected) {
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(`## Магазин · Товары\n${truncate(shopItemList(items, selected), 1800)}`),
    )
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId('admin:shopadd')
          .setLabel('Товар +')
          .setStyle(ButtonStyle.Success)
          .setDisabled(items.length >= 25),
        new ButtonBuilder()
          .setCustomId('admin:shopedit')
          .setLabel('Изменить')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!selected),
        new ButtonBuilder()
          .setCustomId('admin:shoptoggle')
          .setLabel(selected?.enabled === false ? 'Включить' : 'Выключить')
          .setStyle(selected?.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(!selected),
        new ButtonBuilder()
          .setCustomId('admin:shopdel')
          .setLabel('Товар −')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!selected),
        backToShopButton(),
      ),
    );

  if (items.length) {
    container
      .addTextDisplayComponents((text) => text.setContent('**Какой товар править**'))
      .addActionRowComponents((row) =>
        row.setComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin:shoppick')
            .setPlaceholder('Товар')
            .addOptions(
              items.slice(0, 25).map((item) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(truncate(item.name, 100))
                  .setDescription(truncate(`${item.price} баллов · ${item.enabled === false ? 'выкл' : shopStockLabel(item)}`, 100))
                  .setValue(item.id)
                  .setDefault(item.id === selected?.id),
              ),
            ),
        ),
      )
      .addTextDisplayComponents((text) =>
        text.setContent(`**Роль за товар${selected ? ` «${selected.name}»` : ''}**`),
      )
      .addActionRowComponents((row) =>
        row.setComponents(
          new RoleSelectMenuBuilder()
            .setCustomId('admin:shoprole')
            .setPlaceholder('Роль при покупке, можно пусто')
            .setMinValues(0)
            .setMaxValues(1),
        ),
      );
  }

  container
    .addTextDisplayComponents((text) => text.setContent('**Канал заявок на покупку**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('admin:shopbuyreview')
          .setPlaceholder('Куда приходят покупки')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1),
      ),
    );

  return container;
}

function buildShopPoints(balances = [], page = 0, confirmReset = false) {
  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(balances.length / pageSize));
  const current = Math.min(Math.max(0, page), totalPages - 1);
  const start = current * pageSize;
  const shown = balances.slice(start, start + pageSize);
  const list = shown.length
    ? shown.map((entry, index) => `${start + index + 1}. <@${entry.userId}> — **${entry.balance}**`).join('\n')
    : '_Пока ни у кого нет баллов._';
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  container
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## Магазин · Баллы\n` +
          `Всего с балансом: **${balances.length}**` +
          (totalPages > 1 ? ` · стр. **${current + 1}/${totalPages}**` : '') +
          `\n\n${truncate(list, 1800)}\n\n` +
          (confirmReset
            ? '**Обнулить все баллы?** Это сотрёт балансы у всех. Начисленный войс не вернётся сразу — дальше считается заново.'
            : 'Выбери человека — откроется окно, сколько начислить или списать.'),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Выдать баллы**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('admin:shopgive')
          .setPlaceholder('Кому начислить')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    )
    .addTextDisplayComponents((text) => text.setContent('**Забрать баллы**'))
    .addActionRowComponents((row) =>
      row.setComponents(
        new UserSelectMenuBuilder()
          .setCustomId('admin:shoptake')
          .setPlaceholder('У кого списать')
          .setMinValues(1)
          .setMaxValues(1),
      ),
    )
    .addActionRowComponents((row) => {
      if (confirmReset) {
        return row.setComponents(
          new ButtonBuilder().setCustomId('admin:shopresetok').setLabel('Да, обнулить').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('admin:tab:shop:points').setLabel('Отмена').setStyle(ButtonStyle.Secondary),
        );
      }
      const buttons = [
        new ButtonBuilder()
          .setCustomId('admin:shopreset')
          .setLabel('Обнулить все')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!balances.length),
        backToShopButton(),
      ];
      if (totalPages > 1) {
        buttons.unshift(
          new ButtonBuilder()
            .setCustomId(`admin:tab:shop:points:${Math.max(0, current - 1)}`)
            .setLabel('Назад')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(current <= 0),
          new ButtonBuilder()
            .setCustomId(`admin:tab:shop:points:${current + 1}`)
            .setLabel('Дальше')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(current + 1 >= totalPages),
        );
      }
      return row.setComponents(buttons);
    });
  return container;
}

function buildShopTab(guild, section = 'home', extra = {}) {
  const shop = guild.shop || {};
  const items = shop.items || [];
  const selected = items.find((item) => item.id === shop.selectedItemId) || items[0] || null;
  if (section === 'photo') return buildShopPhoto(shop);
  if (section === 'rates') return buildShopRates(shop);
  if (section === 'items') return buildShopItems(shop, items, selected);
  if (section === 'points') return buildShopPoints(extra.balances || [], extra.page || 0, extra.confirmReset);
  return buildShopHome(shop, items);
}

function familyLabel(guild) {
  return String(guild?.familyName || '').trim() || 'Trapaholic';
}

function buildTicketNotice(kind, options = {}) {
  const family = options.familyName || 'Trapaholic';
  const typeLabel = options.typeLabel ? ` **${options.typeLabel}**` : '';
  const admin = options.adminId ? `<@${options.adminId}>` : '—';
  const when = options.at
    ? `<t:${Math.floor(options.at / 1000)}:f> · <t:${Math.floor(options.at / 1000)}:R>`
    : null;
  const styles = {
    submitted: { color: 0x5865f2, title: 'Заявка отправлена' },
    interview: { color: 0xf1c40f, title: 'Обзвон' },
    voice: { color: 0xf1c40f, title: 'Вызов на обзвон' },
    rejected: { color: 0xed4245, title: 'Вердикт по заявке' },
    accepted: { color: 0x57f287, title: 'Вердикт по заявке' },
  };
  const style = styles[kind] || styles.submitted;
  let body = `## ${style.title}\n`;

  if (kind === 'submitted') {
    body +=
      `Заявка${typeLabel} в семью **${family}** отправлена.\n` +
      `Ожидай ответа администрации. Мы свяжемся в ближайшее время.`;
  } else if (kind === 'interview') {
    body +=
      `Твою заявку${typeLabel} в семью **${family}** приняли на обзвон.\n\n` +
      (when ? `**Время:** ${when}\n` : '') +
      (options.channelId ? `**Канал:** <#${options.channelId}>\n` : '') +
      `**Администратор:** ${admin}\n\n` +
      `Если неудобно пройти обзвон — напиши администратору.`;
  } else if (kind === 'voice') {
    body +=
      `Тебя вызвали на обзвон по заявке${typeLabel} в семью **${family}**.\n\n` +
      (options.channelId ? `**Канал:** <#${options.channelId}>\n` : '') +
      `**Администратор:** ${admin}\n\n` +
      `Зайди в голосовой канал. Если неудобно — напиши администратору.`;
  } else if (kind === 'rejected') {
    body +=
      `Твоя заявка${typeLabel} в семью **${family}** отклонена.\n\n` +
      `**Причина:** ${options.reason || 'не указана'}\n` +
      `**Администратор:** ${admin}`;
  } else if (kind === 'accepted') {
    body +=
      `Твоя заявка${typeLabel} в семью **${family}** одобрена.\n` +
      `Поздравляем!\n\n` +
      `**Администратор:** ${admin}` +
      (options.roleId ? `\n**Роль:** <@&${options.roleId}>` : '');
  }

  const container = new ContainerBuilder().setAccentColor(style.color);
  container.addTextDisplayComponents((text) => text.setContent(truncate(body, 3900)));
  return container;
}

module.exports = {
  v2Flags,
  buildPublicPanel,
  buildAdminHub,
  buildSummary,
  buildPanelsTab,
  buildCustomPanel,
  buildCustomPanelsTab,
  buildLogsTab,
  buildAfkTab,
  buildAutoparkPanel,
  buildAutoparkTab,
  buildPositionsPanel,
  buildGatheringPanel,
  buildGatheringList,
  buildGatheringsTab,
  numberedMentions,
  buildActivityTab,
  buildActivityUserTab,
  buildAccessTab,
  buildSecurityTab,
  buildTicketTab,
  buildShopPanel,
  buildShopBalance,
  buildShopReportCatalog,
  buildShopReportReview,
  buildShopPurchaseReview,
  buildShopReportNotice,
  buildShopTab,
  buildTypePage,
  buildDeleteQuestionMenu,
  buildApplicationContainer,
  buildTicketNotice,
  familyLabel,
  buildAfkPanel,
  buildAfkList,
  buildAfkLog,
  formatAfkDuration,
  buildNicksPanel,
  buildNicksTab,
};
