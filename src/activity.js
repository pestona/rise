const fs = require('fs');
const path = require('path');
const { Events } = require('discord.js');

const FILE = path.join(__dirname, '..', 'data', 'activity.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const voiceSessions = new Map();
let saveTimer = null;

function load() {
  try {
    if (!fs.existsSync(FILE)) return { guilds: {} };
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' ? value : { guilds: {} };
  } catch {
    return { guilds: {} };
  }
}

const db = load();
if (!db.guilds || typeof db.guilds !== 'object') db.guilds = {};

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
  }, 1500);
  saveTimer.unref?.();
}

function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function userEntry(guildId, userId, timestamp = Date.now()) {
  const guild = (db.guilds[guildId] ||= { days: {}, completedGatherings: [] });
  guild.days ||= {};
  guild.completedGatherings ||= [];
  const day = (guild.days[dayKey(timestamp)] ||= { users: {} });
  day.users ||= {};
  return (day.users[userId] ||= {
    messages: 0,
    voiceMs: 0,
    gatheringsMain: 0,
    gatheringsBench: 0,
  });
}

function addMessage(guildId, userId, timestamp = Date.now()) {
  userEntry(guildId, userId, timestamp).messages += 1;
  saveSoon();
}

function addVoiceTime(guildId, userId, startedAt, endedAt = Date.now(), persist = true) {
  let cursor = startedAt;
  while (cursor < endedAt) {
    const nextDay = new Date(cursor);
    nextDay.setHours(24, 0, 0, 0);
    const chunkEnd = Math.min(endedAt, nextDay.getTime());
    userEntry(guildId, userId, cursor).voiceMs += Math.max(0, chunkEnd - cursor);
    cursor = chunkEnd;
  }
  if (persist) saveSoon();
}

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function isTrackedVoice(state) {
  return Boolean(state.channelId && state.channelId !== state.guild.afkChannelId);
}

function flushSession(guildId, userId, now = Date.now()) {
  const key = sessionKey(guildId, userId);
  const startedAt = voiceSessions.get(key);
  if (!startedAt) return;
  addVoiceTime(guildId, userId, startedAt, now);
  voiceSessions.set(key, now);
}

function recordGathering(guildId, gathering) {
  if (!gathering?.id) return false;
  const guild = (db.guilds[guildId] ||= { days: {}, completedGatherings: [] });
  guild.completedGatherings ||= [];
  if (guild.completedGatherings.includes(gathering.id)) return false;

  const timestamp = Date.now();
  for (const userId of new Set(gathering.main || [])) {
    userEntry(guildId, userId, timestamp).gatheringsMain += 1;
  }
  for (const userId of new Set(gathering.bench || [])) {
    userEntry(guildId, userId, timestamp).gatheringsBench += 1;
  }
  guild.completedGatherings.push(gathering.id);
  guild.completedGatherings = guild.completedGatherings.slice(-200);
  saveSoon();
  return true;
}

function cutoffFor(period) {
  if (period === 'all') return null;
  const days = period === 'day' ? 1 : period === 'month' ? 30 : 7;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return dayKey(cutoff.getTime());
}

function getActivityStats(guildId, period = 'week') {
  const users = {};
  const cutoff = cutoffFor(period);
  const guild = db.guilds[guildId];

  for (const [date, day] of Object.entries(guild?.days || {})) {
    if (cutoff && date < cutoff) continue;
    for (const [userId, values] of Object.entries(day.users || {})) {
      const target = (users[userId] ||= {
        userId,
        messages: 0,
        voiceMs: 0,
        gatheringsMain: 0,
        gatheringsBench: 0,
      });
      target.messages += values.messages || 0;
      target.voiceMs += values.voiceMs || 0;
      target.gatheringsMain += values.gatheringsMain || 0;
      target.gatheringsBench += values.gatheringsBench || 0;
    }
  }

  const now = Date.now();
  for (const [key, startedAt] of voiceSessions) {
    const separator = key.indexOf(':');
    const sessionGuildId = key.slice(0, separator);
    const userId = key.slice(separator + 1);
    if (sessionGuildId !== guildId) continue;
    if (cutoff && dayKey(startedAt) < cutoff && dayKey(now) < cutoff) continue;
    const target = (users[userId] ||= {
      userId,
      messages: 0,
      voiceMs: 0,
      gatheringsMain: 0,
      gatheringsBench: 0,
    });
    target.voiceMs += Math.max(0, now - Math.max(startedAt, cutoff ? new Date(`${cutoff}T00:00:00`).getTime() : 0));
  }

  return Object.values(users);
}

function setupActivity(client) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId || message.author.bot) return;
    addMessage(message.guildId, message.author.id, message.createdTimestamp);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    const key = sessionKey(newState.guild.id, member.id);
    const now = Date.now();

    if (voiceSessions.has(key)) {
      flushSession(newState.guild.id, member.id, now);
      voiceSessions.delete(key);
    }
    if (isTrackedVoice(newState)) voiceSessions.set(key, now);
  });

  client.once(Events.ClientReady, () => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (!channel.isVoiceBased() || channel.id === guild.afkChannelId) continue;
        for (const member of channel.members.values()) {
          if (!member.user.bot) voiceSessions.set(sessionKey(guild.id, member.id), now);
        }
      }
    }
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const key of [...voiceSessions.keys()]) {
      const separator = key.indexOf(':');
      flushSession(key.slice(0, separator), key.slice(separator + 1), now);
    }
  }, 60_000);
  timer.unref?.();
}

module.exports = {
  setupActivity,
  recordGathering,
  getActivityStats,
};
