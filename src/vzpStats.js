const { EmbedBuilder } = require('discord.js');
const store = require('./store');
const { truncate } = require('./util');

const API = 'https://vzp-gta5rp.com/api';
const FAMILY_NAME = 'RiseFam';
const SERVER_ID = 25;
const watchers = new Map();

function normalizeNick(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/gi, '');
}

async function fetchJson(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`VZP API ${response.status}`);
  return response.json();
}

async function listFamilyEvents() {
  const events = await fetchJson(
    `/events?limit=20&offset=0&server_id=${SERVER_ID}&search=${encodeURIComponent(FAMILY_NAME)}`,
  );
  return Array.isArray(events) ? events : [];
}

async function getEvent(eventId) {
  const event = await fetchJson(`/events/${eventId}`);
  return event && !event.error ? event : null;
}

function isOurFamily(name) {
  return normalizeNick(name) === normalizeNick(FAMILY_NAME);
}

function pickEvent(events, gathering) {
  const startedAt = Number(gathering.startedAt || 0);
  const windowStart = startedAt - 15 * 60 * 1000;
  const ours = events.filter(
    (event) =>
      event.serverId === SERVER_ID &&
      (isOurFamily(event.attackerName) || isOurFamily(event.defenderName)),
  );
  return (
    ours.find((event) => !event.endedAt && new Date(event.startedAt).getTime() >= windowStart) ||
    ours.find((event) => new Date(event.startedAt).getTime() >= windowStart) ||
    ours.find((event) => !event.endedAt) ||
    ours[0] ||
    null
  );
}

function memberKeys(member) {
  return [member.displayName, member.user?.globalName, member.user?.username]
    .filter(Boolean)
    .map(normalizeNick);
}

function findMember(guild, charName) {
  const key = normalizeNick(charName);
  if (!key) return null;
  return (
    guild.members.cache.find((member) => memberKeys(member).includes(key)) ||
    null
  );
}

function mentionOrNick(guild, charName) {
  const member = findMember(guild, charName);
  return member ? `<@${member.id}>` : charName;
}

function ourSidePlayers(event) {
  if (isOurFamily(event.attackerName)) return event.attackers || [];
  if (isOurFamily(event.defenderName)) return event.defenders || [];
  return [];
}

function buildVzpCard(guild, gathering, event) {
  const main = gathering.main || [];
  const bench = gathering.bench || [];
  const mainSet = new Set(main);
  const benchSet = new Set(bench);
  const inTerra = ourSidePlayers(event);
  const inTerraIds = new Set();
  const fromReserve = [];
  const notFromList = [];

  for (const player of inTerra) {
    const member = findMember(guild, player.charName);
    if (member && mainSet.has(member.id)) {
      inTerraIds.add(member.id);
    } else if (member && benchSet.has(member.id)) {
      inTerraIds.add(member.id);
      fromReserve.push(member.id);
    } else if (member) {
      inTerraIds.add(member.id);
      notFromList.push(player.charName);
    } else {
      notFromList.push(player.charName);
    }
  }

  const missedMain = main.filter((userId) => !inTerraIds.has(userId));
  const weAttack = isOurFamily(event.attackerName);
  const opponent = weAttack ? event.defenderName : event.attackerName;
  const finished = event.isAttackerWin !== null && event.isAttackerWin !== undefined;
  const weWon = finished && isOurFamily(event.winnerName);
  const side = weAttack ? 'Атака' : 'Защита';
  const point = event.pointName || 'карта';
  const title = finished
    ? `${weWon ? '🏆 ПОБЕДА' : '❌ ПОРАЖЕНИЕ'} — ${point} (${side})`
    : `⏳ В ПРОЦЕССЕ — ${point} (${side})`;
  const maxPlayers = event.maxPlayers || inTerra.length || gathering.maxMain || 0;
  const threadLine = gathering.threadId
    ? `<#${gathering.threadId}>`
    : 'неизвестно';

  const notes = [];
  if (fromReserve.length) {
    notes.push(
      fromReserve.map((id) => `<@${id}> — из резерва`).join('\n'),
    );
  }
  if (notFromList.length) {
    notes.push(notFromList.map((nick) => `${nick} — не из списка`).join('\n'));
  }
  if (missedMain.length) {
    notes.push(`Из основы не зашли: **${missedMain.length}**`);
  }

  const roster = inTerra.length
    ? inTerra
        .map((player, index) => `${index + 1}. ${mentionOrNick(guild, player.charName)}`)
        .join('\n')
    : '_Пока нет состава с мониторинга._';
  const reserve = bench.length
    ? bench.map((id, index) => `${index + 1}. <@${id}>`).join('\n')
    : '_пусто_';

  const embed = new EmbedBuilder()
    .setColor(finished ? (weWon ? 0x57f287 : 0xed4245) : 0xfee75c)
    .setTitle(truncate(title, 256))
    .setDescription(
      truncate(
        `**${FAMILY_NAME}** vs **${opponent || '—'}**\n` +
          `Матч начат: **${event.attackerName || '—'}**\n` +
          `Список перенесён в ветку: ${threadLine}\n` +
          (notes.length ? `\n${notes.join('\n')}\n` : '\n') +
          `\n**Состав ${inTerra.length}/${maxPlayers}** · ${finished ? 'Завершён' : 'Идёт'}\n` +
          `${roster}`,
        4000,
      ),
    )
    .addFields({
      name: `Резерв · ${bench.length}`,
      value: truncate(reserve, 1024),
    })
    .setFooter({ text: 'BETA · данные с vzp-gta5rp.com + список сбора' })
    .setTimestamp(event.endedAt ? new Date(event.endedAt) : new Date(event.startedAt));

  return {
    embeds: [embed],
    allowedMentions: { parse: [] },
  };
}

function waitingCard(gathering) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('⏳ Ждём данные VZP')
        .setDescription(
          `Сбор **${gathering.content || gathering.title}** закрыт.\n` +
            `Как только матч RiseFam появится на мониторинге Chiliad, карточка обновится.`,
        )
        .setFooter({ text: 'BETA · vzp-gta5rp.com' }),
    ],
    allowedMentions: { parse: [] },
  };
}

function getStatsChannelId(guildId) {
  return store.getGuild(guildId).gatherings?.statsChannelId || null;
}

async function sendOrEditCard(client, gathering, payload) {
  const guildId = gathering.guildId || gathering._guildId;
  const channelId = getStatsChannelId(guildId);
  if (!channelId) {
    console.warn('Канал VZP-статы не выбран в админке сборов.');
    return null;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  if (gathering.statsMessageId) {
    const message = await channel.messages.fetch(gathering.statsMessageId).catch(() => null);
    if (message) {
      await message.edit(payload);
      return message;
    }
  }

  const message = await channel.send(payload);
  store.updateGuild(guildId, (guild) => {
    if (guild.gatherings.active?.id === gathering.id) {
      guild.gatherings.active.statsMessageId = message.id;
    }
  });
  return message;
}

async function refreshVzpStats(client, guildId) {
  const settings = store.getGuild(guildId);
  const gathering = settings.gatherings?.active;
  if (!gathering?.closed || !settings.gatherings?.statsChannelId) return null;
  gathering._guildId = guildId;

  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch().catch(() => null);

  try {
    const events = await listFamilyEvents();
    const summary = pickEvent(events, gathering);
    if (!summary) {
      await sendOrEditCard(client, gathering, waitingCard(gathering));
      return null;
    }
    const event = (await getEvent(summary.eventId)) || summary;
    const payload = buildVzpCard(guild, gathering, event);
    await sendOrEditCard(client, gathering, payload);
    return event;
  } catch (error) {
    console.warn('Не удалось получить стату VZP:', error.message);
    await sendOrEditCard(client, gathering, waitingCard(gathering)).catch(() => null);
    return null;
  }
}

function stopWatching(guildId) {
  const timer = watchers.get(guildId);
  if (timer) clearInterval(timer);
  watchers.delete(guildId);
}

function watchVzpStats(client, guildId) {
  stopWatching(guildId);
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 45 * 60 * 1000) {
      stopWatching(guildId);
      return;
    }
    const event = await refreshVzpStats(client, guildId).catch((error) => {
      console.warn('Ошибка обновления VZP статы:', error.message);
      return null;
    });
    if (event?.endedAt) stopWatching(guildId);
  }, 30_000);
  timer.unref?.();
  watchers.set(guildId, timer);
}

async function publishVzpStats(client, guildId) {
  const event = await refreshVzpStats(client, guildId);
  if (!event?.endedAt) watchVzpStats(client, guildId);
  return event;
}

module.exports = {
  publishVzpStats,
  refreshVzpStats,
};
