const { Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const store = require('./store');
const { hasAccess } = require('./util');

function canAssignJoinRole(me, role) {
  if (!me || !role || role.managed || role.id === role.guild.id) return false;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  return me.roles.highest.comparePositionTo(role) > 0;
}

async function assignJoinRole(member) {
  if (!member || member.user?.bot || member.pending) return;
  const roleId = store.getGuild(member.guild.id).joinRoleId;
  if (!roleId || member.roles.cache.has(roleId)) return;
  const role = member.guild.roles.cache.get(roleId);
  const me = member.guild.members.me;
  if (!canAssignJoinRole(me, role)) {
    console.warn(`Не удалось выдать роль новичка ${roleId} на ${member.guild.id}: нет прав или роль выше бота.`);
    return;
  }
  await member.roles.add(role, 'Автороль при входе').catch((error) => {
    console.warn('Не удалось выдать автороль новичку:', error.message);
  });
}

async function handleJoinRoleCommand(interaction) {
  const settings = store.getGuild(interaction.guildId);
  if (!hasAccess(interaction.member, settings, 'settingsManage')) {
    return interaction.reply({
      content: 'У вас нет доступа к команде `/роль`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const role = interaction.options.getRole('роль', true);
  const me = interaction.guild.members.me;
  if (role.id === interaction.guild.id) {
    return interaction.reply({
      content: 'Нельзя ставить @everyone. Выбери обычную роль.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (role.managed) {
    return interaction.reply({
      content: 'Эту роль выдаёт интеграция, бот её не может назначить.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!canAssignJoinRole(me, role)) {
    return interaction.reply({
      content: 'Бот не может выдать эту роль. Нужно право Manage Roles, и роль бота должна быть выше выбранной.',
      flags: MessageFlags.Ephemeral,
    });
  }

  store.updateGuild(interaction.guildId, (guild) => {
    guild.joinRoleId = role.id;
  });
  return interaction.reply({
    content: `Новичкам при входе будет выдаваться ${role}.`,
    flags: MessageFlags.Ephemeral,
  });
}

function setupJoinRole(client) {
  client.on(Events.GuildMemberAdd, (member) => {
    assignJoinRole(member).catch(console.error);
  });
  client.on(Events.GuildMemberUpdate, (oldMember, member) => {
    if (oldMember.pending && !member.pending) {
      assignJoinRole(member).catch(console.error);
    }
  });
}

module.exports = {
  handleJoinRoleCommand,
  setupJoinRole,
};
