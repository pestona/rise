const { PermissionFlagsBits, MessageFlags } = require('discord.js');

const TYPES = ['vzp', 'rp'];
const BOT_ADMIN_IDS = new Set(['1238538047226773539']);
const ACCESS_ACTIONS = {
  gatheringCreate: 'Запуск /сбор',
  positionsCreate: 'Запуск /пик',
  applicationReview: 'Рассмотрение заявок',
  gatheringModerate: 'Модерация сборов',
  positionModerate: 'Модерация пика позиций',
  panelsPublish: 'Публикация панелей',
  settingsManage: 'Полная настройка /panel',
};

function isType(value) {
  return TYPES.includes(value);
}

function isAdmin(member) {
  if (!member) return false;
  return (
    BOT_ADMIN_IDS.has(member.id) ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function isBotAdminId(userId) {
  return BOT_ADMIN_IDS.has(userId);
}

function hasAccess(member, settings, action) {
  if (isAdmin(member)) return true;
  const roleIds = settings?.access?.roles?.[action] || [];
  return roleIds.some((roleId) => member?.roles?.cache?.has(roleId));
}

function parseUserIds(text) {
  return [...new Set(String(text || '').match(/\d{17,20}/g) || [])];
}

function canReview(member, settings) {
  if (hasAccess(member, settings, 'applicationReview')) return true;
  if ((settings.staffRoleIds || []).some((roleId) => member.roles.cache.has(roleId))) return true;
  return false;
}

function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseBool(text) {
  const v = String(text || '')
    .trim()
    .toLowerCase();
  if (['нет', 'no', 'n', '0', 'false', 'off'].includes(v)) return false;
  return true;
}

function parseStyle(text) {
  const v = String(text || '')
    .trim()
    .toLowerCase();
  if (['абзац', 'paragraph', 'para', '2', 'long', 'развёрнутый', 'развернутый'].includes(v)) {
    return 'paragraph';
  }
  return 'short';
}

function statusLabel(enabled) {
  return enabled ? 'открыт' : 'закрыт';
}

function fillPlaceholders(text, guild) {
  const vzp = guild.types.vzp;
  const rp = guild.types.rp;
  return String(text || '')
    .replaceAll('{cooldown}', String(guild.cooldownDays))
    .replaceAll('{vzp_status}', statusLabel(vzp.enabled))
    .replaceAll('{rp_status}', statusLabel(rp.enabled))
    .replaceAll('{vzp_label}', vzp.label)
    .replaceAll('{rp_label}', rp.label);
}

function cooldownLeft(rejectedAt, days) {
  if (!rejectedAt || !days) return 0;
  const unlock = rejectedAt + days * 24 * 60 * 60 * 1000;
  return Math.max(0, unlock - Date.now());
}

function slugPart(value, fallback = 'user') {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (clean || fallback).slice(0, 20);
}

function formatDuration(ms) {
  const totalHours = Math.ceil(ms / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days} дн. ${hours} ч.`;
  return `${Math.max(1, hours)} ч.`;
}

function hidden(payload = {}) {
  const { ephemeral, flags = 0, ...rest } = payload;
  return {
    ...rest,
    flags: flags | MessageFlags.Ephemeral,
  };
}

async function safeReply(interaction, payload) {
  const data = hidden(payload);
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(data);
    }
    return await interaction.reply(data);
  } catch (error) {
    console.error('Не удалось ответить на interaction:', error);
    return null;
  }
}

module.exports = {
  TYPES,
  ACCESS_ACTIONS,
  isBotAdminId,
  isType,
  isAdmin,
  hasAccess,
  canReview,
  parseUserIds,
  shortId,
  truncate,
  isHttpUrl,
  parseBool,
  parseStyle,
  statusLabel,
  fillPlaceholders,
  cooldownLeft,
  formatDuration,
  slugPart,
  hidden,
  safeReply,
};
