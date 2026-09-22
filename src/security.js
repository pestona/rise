const {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} = require('discord.js');
const store = require('./store');
const { isBotAdminId } = require('./util');

const counters = new Map();
const handledAudits = new Map();
const maintenanceGuilds = new Set();
const AUDIT_MAX_AGE = 8_000;
const BACKUP_INTERVAL = 24 * 60 * 60 * 1000;
const BACKUP_CHECK_INTERVAL = 60 * 60 * 1000;
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeOverwrites(channel) {
  return channel.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
}

function serializeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    position: channel.rawPosition,
    topic: 'topic' in channel ? channel.topic : null,
    nsfw: 'nsfw' in channel ? channel.nsfw : false,
    rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 0,
    bitrate: 'bitrate' in channel ? channel.bitrate : null,
    userLimit: 'userLimit' in channel ? channel.userLimit : null,
    rtcRegion: 'rtcRegion' in channel ? channel.rtcRegion : null,
    defaultAutoArchiveDuration:
      'defaultAutoArchiveDuration' in channel ? channel.defaultAutoArchiveDuration : null,
    defaultThreadRateLimitPerUser:
      'defaultThreadRateLimitPerUser' in channel ? channel.defaultThreadRateLimitPerUser : null,
    availableTags: 'availableTags' in channel ? channel.availableTags : null,
    defaultReactionEmoji: 'defaultReactionEmoji' in channel ? channel.defaultReactionEmoji : null,
    defaultSortOrder: 'defaultSortOrder' in channel ? channel.defaultSortOrder : null,
    defaultForumLayout: 'defaultForumLayout' in channel ? channel.defaultForumLayout : null,
    permissionOverwrites: serializeOverwrites(channel),
  };
}

async function createBackup(guild) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const backup = {
    version: 1,
    guildId: guild.id,
    guildName: guild.name,
    createdAt: Date.now(),
    everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
    roles: guild.roles.cache
      .filter((role) => role.id !== guild.id && !role.managed)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        permissions: role.permissions.bitfield.toString(),
        mentionable: role.mentionable,
        position: role.rawPosition,
      })),
    channels: guild.channels.cache
      .filter((channel) => !channel.isThread())
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map(serializeChannel),
  };
  store.setBackup(guild.id, backup);
  store.updateGuild(guild.id, (settings) => {
    settings.security.lastBackupAt = backup.createdAt;
  });
  return backup;
}

async function createDueBackups(client) {
  for (const guild of client.guilds.cache.values()) {
    const settings = store.getGuild(guild.id);
    const backup = store.getBackup(guild.id);
    const lastBackupAt = backup?.createdAt || settings.security?.lastBackupAt || 0;
    if (Date.now() - lastBackupAt < BACKUP_INTERVAL) continue;
    try {
      await createBackup(guild);
      console.log(`Автоматическая резервная копия создана для ${guild.name}`);
    } catch (error) {
      console.error(`Не удалось создать резервную копию для ${guild.name}:`, error);
    }
  }
}

function setupBackupTimers(client) {
  client.once(Events.ClientReady, () => {
    createDueBackups(client).catch(console.error);
    setInterval(() => createDueBackups(client).catch(console.error), BACKUP_CHECK_INTERVAL);
  });
}

function overwriteOptions(items, roleMap) {
  return items.map((item) => ({
    id: roleMap.get(item.id) || item.id,
    type: item.type,
    allow: BigInt(item.allow),
    deny: BigInt(item.deny),
  }));
}

function channelOptions(item, channelMap, roleMap) {
  const options = {
    name: item.name,
    type: item.type,
    position: item.position,
    parent: item.parentId ? channelMap.get(item.parentId) || item.parentId : null,
    permissionOverwrites: overwriteOptions(item.permissionOverwrites || [], roleMap),
    reason: 'Ручное восстановление резервной копии',
  };
  if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(item.type)) {
    options.topic = item.topic;
    options.nsfw = item.nsfw;
    options.rateLimitPerUser = item.rateLimitPerUser || 0;
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(item.type)) {
    options.bitrate = item.bitrate || undefined;
    options.userLimit = item.userLimit || 0;
    options.rtcRegion = item.rtcRegion;
  }
  if (item.defaultAutoArchiveDuration) {
    options.defaultAutoArchiveDuration = item.defaultAutoArchiveDuration;
  }
  if (item.type === ChannelType.GuildForum) {
    options.availableTags = item.availableTags || [];
    options.defaultReactionEmoji = item.defaultReactionEmoji;
    options.defaultThreadRateLimitPerUser = item.defaultThreadRateLimitPerUser || 0;
    options.defaultSortOrder = item.defaultSortOrder;
    options.defaultForumLayout = item.defaultForumLayout;
  }
  return options;
}

function remapSettings(guildId, roleMap, channelMap, recreatedChannelIds) {
  const mapRole = (id) => roleMap.get(id) || id;
  const mapChannel = (id) => channelMap.get(id) || id;
  store.updateGuild(guildId, (settings) => {
    settings.staffRoleIds = (settings.staffRoleIds || []).map(mapRole);
    settings.logs.watchedRoleIds = settings.logs.watchedRoleIds.map(mapRole);
    for (const vehicle of settings.autopark.vehicles) {
      vehicle.roleIds = vehicle.roleIds.map(mapRole);
    }
    for (const type of Object.values(settings.types)) {
      type.roleId = mapRole(type.roleId);
      type.reviewChannelId = mapChannel(type.reviewChannelId);
      type.acceptedChannelId = mapChannel(type.acceptedChannelId);
      type.resultForumId = mapChannel(type.resultForumId);
      type.logChannelId = mapChannel(type.logChannelId);
    }
    settings.logs.leaveChannelId = mapChannel(settings.logs.leaveChannelId);
    settings.logs.moderationChannelId = mapChannel(settings.logs.moderationChannelId);
    settings.security.logChannelId = mapChannel(settings.security.logChannelId);
    if (settings.access?.roles) {
      for (const key of Object.keys(settings.access.roles)) {
        settings.access.roles[key] = settings.access.roles[key].map(mapRole);
      }
    }
    if (settings.gatherings) {
      settings.gatherings.listChannelId = mapChannel(settings.gatherings.listChannelId);
      if (settings.gatherings.active?.channelId) {
        settings.gatherings.active.channelId = mapChannel(settings.gatherings.active.channelId);
      }
      if (settings.gatherings.active?.pingRoleIds) {
        settings.gatherings.active.pingRoleIds =
          settings.gatherings.active.pingRoleIds.map(mapRole);
      }
    }
    settings.panels = settings.panels.filter((panel) => !recreatedChannelIds.has(panel.channelId));
    const lastPanel = settings.panels[settings.panels.length - 1];
    settings.panel = lastPanel
      ? { channelId: lastPanel.channelId, messageId: lastPanel.messageId }
      : { channelId: null, messageId: null };
    if (recreatedChannelIds.has(settings.adminPanel.channelId)) {
      settings.adminPanel = { channelId: null, messageId: null };
    }
  });
}

async function restoreBackup(guild) {
  const backup = store.getBackup(guild.id);
  if (!backup) throw new Error('Резервная копия не найдена');
  maintenanceGuilds.add(guild.id);
  const result = { rolesCreated: 0, rolesUpdated: 0, channelsCreated: 0, channelsUpdated: 0, errors: [] };
  const roleMap = new Map([[guild.id, guild.id]]);
  const channelMap = new Map();
  const recreatedChannelIds = new Set();

  try {
    await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    await guild.roles.everyone
      .setPermissions(BigInt(backup.everyonePermissions), 'Восстановление резервной копии')
      .catch((error) => result.errors.push(`@everyone: ${error.message}`));

    for (const item of backup.roles) {
      let role = guild.roles.cache.get(item.id);
      try {
        if (!role) {
          role = await guild.roles.create({
            name: item.name,
            color: item.color,
            hoist: item.hoist,
            permissions: BigInt(item.permissions),
            mentionable: item.mentionable,
            reason: 'Восстановление резервной копии',
          });
          result.rolesCreated += 1;
        } else {
          await role.edit({
            name: item.name,
            color: item.color,
            hoist: item.hoist,
            permissions: BigInt(item.permissions),
            mentionable: item.mentionable,
            reason: 'Восстановление резервной копии',
          });
          result.rolesUpdated += 1;
        }
        roleMap.set(item.id, role.id);
        if (role.editable) await role.setPosition(item.position).catch(() => null);
      } catch (error) {
        result.errors.push(`Роль ${item.name}: ${error.message}`);
      }
    }

    const orderedChannels = [
      ...backup.channels.filter((item) => item.type === ChannelType.GuildCategory),
      ...backup.channels.filter((item) => item.type !== ChannelType.GuildCategory),
    ];
    for (const item of orderedChannels) {
      let target = guild.channels.cache.get(item.id);
      try {
        const options = channelOptions(item, channelMap, roleMap);
        if (!target) {
          target = await guild.channels.create(options);
          result.channelsCreated += 1;
          recreatedChannelIds.add(item.id);
        } else {
          const editOptions = { ...options };
          delete editOptions.type;
          await target.edit(editOptions);
          result.channelsUpdated += 1;
        }
        channelMap.set(item.id, target.id);
      } catch (error) {
        result.errors.push(`Канал ${item.name}: ${error.message}`);
      }
    }

    remapSettings(guild.id, roleMap, channelMap, recreatedChannelIds);
    return result;
  } finally {
    setTimeout(() => maintenanceGuilds.delete(guild.id), 5_000);
  }
}

async function auditEntry(guild, type, targetId) {
  await wait(900);
  const logs = await guild.fetchAuditLogs({ type, limit: 8 }).catch(() => null);
  if (!logs) return null;
  return (
    logs.entries.find(
      (entry) =>
        (!targetId || entry.target?.id === targetId) &&
        Date.now() - entry.createdTimestamp <= AUDIT_MAX_AGE,
    ) || null
  );
}

async function isTrusted(guild, userId, settings) {
  if (!userId || userId === guild.ownerId || userId === guild.client.user.id) return true;
  if (isBotAdminId(userId)) return true;
  if (settings.security.managerUserIds?.includes(userId)) return true;
  if (settings.security.trustedUserIds.includes(userId)) return true;
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(
    member && settings.security.trustedRoleIds.some((roleId) => member.roles.cache.has(roleId)),
  );
}

async function sendSecurityLog(guild, executorId, action, removedRoles, immediate) {
  const settings = store.getGuild(guild.id);
  const channel = settings.security.logChannelId
    ? await guild.channels.fetch(settings.security.logChannelId).catch(() => null)
    : null;
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return;
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('Anti-Nuke сработал')
    .setDescription(`<@${executorId}> обезврежен системой защиты.`)
    .addFields(
      { name: 'Действие', value: action },
      { name: 'Реакция', value: `Снято ролей: ${removedRoles}${immediate ? '\nНемедленное срабатывание' : ''}` },
    )
    .setFooter({ text: `ID нарушителя: ${executorId}` })
    .setTimestamp();
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
}

async function neutralize(guild, executorId, action, immediate = false) {
  if (isBotAdminId(executorId)) return;
  const settings = store.getGuild(guild.id);
  if (settings.security?.managerUserIds?.includes(executorId)) return;
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member || member.id === guild.ownerId) return;
  const removable = member.roles.cache.filter(
    (role) => role.id !== guild.id && !role.managed && role.editable,
  );
  let removed = 0;
  if (removable.size) {
    await member.roles
      .remove([...removable.keys()], `Anti-Nuke: ${action}`)
      .then(() => {
        removed = removable.size;
      })
      .catch(() => null);
  }
  if (member.moderatable) {
    await member.timeout(28 * 24 * 60 * 60 * 1000, `Anti-Nuke: ${action}`).catch(() => null);
  }
  await sendSecurityLog(guild, executorId, action, removed, immediate);
}

async function processAudit(guild, type, targetId, action, options = {}) {
  if (maintenanceGuilds.has(guild.id)) return;
  const settings = store.getGuild(guild.id);
  if (!settings.security.enabled) return;
  const entry = options.entry || (await auditEntry(guild, type, targetId));
  if (!entry?.executorId) return;

  const guildAudits = handledAudits.get(guild.id) || new Set();
  if (guildAudits.has(entry.id)) return;
  guildAudits.add(entry.id);
  handledAudits.set(guild.id, guildAudits);
  setTimeout(() => guildAudits.delete(entry.id), 60_000);

  if (await isTrusted(guild, entry.executorId, settings)) return;
  if (options.revert) await options.revert().catch(() => null);
  if (options.removeTarget) await options.removeTarget().catch(() => null);

  const now = Date.now();
  const key = `${guild.id}:${entry.executorId}`;
  const windowMs = settings.security.windowSeconds * 1000;
  const hits = (counters.get(key) || []).filter((time) => now - time <= windowMs);
  hits.push(now);
  counters.set(key, hits);
  if (options.immediate || hits.length >= settings.security.actionLimit) {
    counters.delete(key);
    await neutralize(guild, entry.executorId, action, options.immediate);
  }
}

function dangerousPermissionAdded(oldRole, newRole) {
  return DANGEROUS_PERMISSIONS.some(
    (permission) => !oldRole.permissions.has(permission) && newRole.permissions.has(permission),
  );
}

function setupSecurity(client) {
  client.on(Events.ChannelCreate, (channel) =>
    processAudit(channel.guild, AuditLogEvent.ChannelCreate, channel.id, `Создание канала ${channel.name}`).catch(console.error),
  );
  client.on(Events.ChannelDelete, (channel) =>
    processAudit(channel.guild, AuditLogEvent.ChannelDelete, channel.id, `Удаление канала ${channel.name}`).catch(console.error),
  );
  client.on(Events.ChannelUpdate, (oldChannel, newChannel) =>
    processAudit(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id, `Изменение канала ${newChannel.name}`).catch(console.error),
  );
  client.on(Events.GuildRoleCreate, (role) => {
    const dangerous = DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission));
    processAudit(role.guild, AuditLogEvent.RoleCreate, role.id, `Создание роли ${role.name}`, {
      immediate: dangerous,
      revert: dangerous
        ? () => role.setPermissions(0n, 'Anti-Nuke: отмена опасных прав')
        : null,
    }).catch(console.error);
  });
  client.on(Events.GuildRoleDelete, (role) =>
    processAudit(role.guild, AuditLogEvent.RoleDelete, role.id, `Удаление роли ${role.name}`).catch(console.error),
  );
  client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
    const dangerous = dangerousPermissionAdded(oldRole, newRole);
    processAudit(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id, `Изменение роли ${newRole.name}`, {
      immediate: dangerous,
      revert: dangerous
        ? () => newRole.setPermissions(oldRole.permissions, 'Anti-Nuke: отмена опасных прав')
        : null,
    }).catch(console.error);
  });
  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    const addedDangerousRoles = newMember.roles.cache.filter(
      (role) =>
        !oldMember.roles.cache.has(role.id) &&
        DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission)),
    );
    if (!addedDangerousRoles.size) return;
    processAudit(
      newMember.guild,
      AuditLogEvent.MemberRoleUpdate,
      newMember.id,
      `Выдача опасной роли пользователю ${newMember.user.tag}`,
      {
        immediate: true,
        revert: () =>
          newMember.roles.remove(
            [...addedDangerousRoles.keys()],
            'Anti-Nuke: отмена выдачи опасной роли',
          ),
      },
    ).catch(console.error);
  });
  client.on(Events.GuildBanAdd, (ban) =>
    processAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, `Бан ${ban.user.tag}`).catch(console.error),
  );
  client.on(Events.GuildMemberRemove, (member) =>
    processAudit(member.guild, AuditLogEvent.MemberKick, member.id, `Кик ${member.user.tag}`).catch(console.error),
  );
  client.on(Events.GuildMemberAdd, (member) => {
    if (!member.user.bot || member.id === client.user.id) return;
    processAudit(member.guild, AuditLogEvent.BotAdd, member.id, `Добавление бота ${member.user.tag}`, {
      immediate: true,
      removeTarget: () => member.kick('Anti-Nuke: бот добавлен не из белого списка'),
    }).catch(console.error);
  });
  client.on(Events.GuildUpdate, (oldGuild, newGuild) =>
    processAudit(newGuild, AuditLogEvent.GuildUpdate, newGuild.id, 'Изменение настроек сервера').catch(console.error),
  );
  client.on(Events.WebhooksUpdate, async (channel) => {
    const entries = [];
    for (const type of [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete]) {
      const entry = await auditEntry(channel.guild, type, null);
      if (entry) entries.push({ type, entry });
    }
    entries.sort((a, b) => b.entry.createdTimestamp - a.entry.createdTimestamp);
    if (entries[0]) {
      await processAudit(
        channel.guild,
        entries[0].type,
        entries[0].entry.target?.id,
        'Изменение вебхуков',
        { entry: entries[0].entry },
      );
    }
  });
}

module.exports = {
  setupSecurity,
  setupBackupTimers,
  createBackup,
  restoreBackup,
  maintenanceGuilds,
};
