const { AuditLogEvent, ChannelType, EmbedBuilder, Events } = require('discord.js');
const store = require('./store');

const recentBans = new Map();
const AUDIT_WINDOW = 15_000;

function leftUserName(member) {
  const user = member.user;
  return member.displayName || user?.globalName || user?.username || user?.tag || `ID ${member.id}`;
}

function leftUserTag(member) {
  const user = member.user;
  return user?.tag || user?.username || member.id;
}

function rolesText(member) {
  if (!member.roles?.cache || typeof member.roles.cache.filter !== 'function') return '—';
  const roles = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => `<@&${role.id}>`);
  return roles.length ? roles.join(' ') : '—';
}

async function getLogChannel(guild, channelId) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return null;
  return channel;
}

async function recentAuditEntry(guild, type, userId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    return (
      logs.entries.find(
        (entry) =>
          entry.target?.id === userId &&
          Date.now() - entry.createdTimestamp <= AUDIT_WINDOW,
      ) || null
    );
  } catch {
    return null;
  }
}

async function sendLeaveLog(member) {
  const settings = store.getGuild(member.guild.id);
  const watched = settings.logs?.watchedRoleIds || [];
  if (!watched.length || !watched.some((id) => member.roles.cache.has(id))) return;

  const channel = await getLogChannel(member.guild, settings.logs?.leaveChannelId);
  if (!channel) return;

  const name = leftUserName(member);
  const embed = new EmbedBuilder()
    .setColor(0x747f8d)
    .setTitle(`${name} покинул ${member.guild.name}`)
    .setDescription(`**${name}** · \`${leftUserTag(member)}\`\n<@${member.id}>`)
    .addFields({ name: 'Роли пользователя', value: rolesText(member) })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(console.error);
}

async function sendModerationLog(member, action, entry) {
  const settings = store.getGuild(member.guild.id);
  const channel = await getLogChannel(member.guild, settings.logs?.moderationChannelId);
  if (!channel) return;

  const banned = action === 'ban';
  const embed = new EmbedBuilder()
    .setColor(banned ? 0xed4245 : 0xfee75c)
    .setTitle(banned ? 'Пользователь был забанен' : 'Пользователь был кикнут')
    .setDescription(
      `<@${entry?.executor?.id || member.guild.client.user.id}> ` +
        `${banned ? 'забанил' : 'кикнул'} <@${member.id}>`,
    )
    .addFields(
      { name: 'Причина', value: entry?.reason || 'Причина не указана' },
      { name: 'Роли пользователя', value: rolesText(member) },
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(console.error);
}

async function handleMemberRemove(member) {
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const key = `${member.guild.id}:${member.id}`;
  if (Date.now() - (recentBans.get(key) || 0) <= AUDIT_WINDOW) return;

  const banEntry = await recentAuditEntry(member.guild, AuditLogEvent.MemberBanAdd, member.id);
  if (banEntry) {
    recentBans.set(key, Date.now());
    await sendModerationLog(member, 'ban', banEntry);
    return;
  }

  const kickEntry = await recentAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id);
  if (kickEntry) {
    await sendModerationLog(member, 'kick', kickEntry);
    return;
  }

  await sendLeaveLog(member);
}

async function handleBan(ban) {
  const key = `${ban.guild.id}:${ban.user.id}`;
  if (Date.now() - (recentBans.get(key) || 0) <= AUDIT_WINDOW) return;
  recentBans.set(key, Date.now());
  setTimeout(() => recentBans.delete(key), AUDIT_WINDOW * 2);

  const memberLike = {
    id: ban.user.id,
    user: ban.user,
    guild: ban.guild,
    client: ban.guild.client,
    roles: { cache: new Map() },
  };
  const entry = await recentAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  await sendModerationLog(memberLike, 'ban', entry);
}

function setupMemberLogs(client) {
  client.on(Events.GuildMemberRemove, (member) => {
    handleMemberRemove(member).catch((error) => console.error('Ошибка лога выхода:', error));
  });
  client.on(Events.GuildBanAdd, (ban) => {
    handleBan(ban).catch((error) => console.error('Ошибка лога бана:', error));
  });
}

module.exports = { setupMemberLogs };
