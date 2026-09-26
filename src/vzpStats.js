const {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const store = require('./store');
const { truncate } = require('./util');

const API = 'https://vzp-gta5rp.com/api';
const FAMILY_NAME = 'RiseFam';
const SERVER_ID = 25;
const MATCH_WINDOW_MS = 3 * 60 * 60 * 1000;
const watchers = new Map();

const MAP_NAMES = {
  NEW_B_GHETTO_ANTS: 'Муравейник',
  NEW_S_GHETTO_ANTS: 'Муравейник',
  NEW_S_SANDYSHORES: 'Сэнди-Шорс',
  NEW_S_WINDFARM: 'Ветряки',
  NEW_S_ELBURRO: 'Эль-Бурро',
  NEW_S_BANNING_ANGAR: 'Ангар',
  NEW_B_LS_CINEMA: 'Киностудия',
  NEW_S_EL_RANCHO_SMALL_OILBASE: 'Нефтебаза',
  NEW_S_PUERTA_DUMP: 'Мусорка',
};

function mapName(code) {
  return MAP_NAMES[code] || code || 'карта';
}

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

async function listFamilyEvents(limit = 50) {
  const events = await fetchJson(
    `/events?limit=${limit}&offset=0&server_id=${SERVER_ID}&search=${encodeURIComponent(FAMILY_NAME)}`,
  );
  return (Array.isArray(events) ? events : []).filter(
    (event) =>
      event.serverId === SERVER_ID &&
      (isOurFamily(event.attackerName) || isOurFamily(event.defenderName)),
  );
}

function eventDay(startedAt) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(startedAt));
}

function formatDayLabel(day) {
  const [year, month, date] = String(day).split('-');
  return `${date}.${month}.${year}`;
}

function formatEventTime(startedAt) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(startedAt));
}

function opponentName(event) {
  return isOurFamily(event.attackerName) ? event.defenderName : event.attackerName;
}

function eventOptionLabel(event) {
  const mark = !event.endedAt ? 'идёт' : isOurFamily(event.winnerName) ? 'W' : 'L';
  return truncate(
    `${formatEventTime(event.startedAt)} ${mark} vs ${opponentName(event) || '—'} · ${event.pointName || 'карта'}`,
    100,
  );
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

function firstNameKey(name) {
  const part = String(name || '')
    .trim()
    .split(/[\s_|.\-]+/)[0] || '';
  return normalizeNick(part);
}

function memberFirstNames(member) {
  return [member.displayName, member.user?.globalName, member.user?.username]
    .filter(Boolean)
    .map(firstNameKey)
    .filter(Boolean);
}

function findMember(guild, charName, preferredIds = null) {
  const key = normalizeNick(charName);
  if (!key) return null;
  const exact = guild.members.cache.find((member) => memberKeys(member).includes(key));
  if (exact) return exact;

  const first = firstNameKey(charName);
  if (first.length >= 3) {
    const byFirst = guild.members.cache.filter((member) => memberFirstNames(member).includes(first));
    if (byFirst.size === 1) return byFirst.first();
    if (byFirst.size > 1 && preferredIds) {
      const preferred = byFirst.filter((member) => preferredIds.has(member.id));
      if (preferred.size === 1) return preferred.first();
    }
  }

  if (key.length < 5) return null;
  return (
    guild.members.cache.find((member) =>
      memberKeys(member).some(
        (nick) => nick.length >= 5 && (nick.includes(key) || key.includes(nick)),
      ),
    ) || null
  );
}

function gatheringMoment(gathering) {
  return Number(gathering?.timeAt || gathering?.closedAt || gathering?.startedAt || 0);
}

function listKnownGatherings(settings) {
  const items = [];
  const seen = new Set();
  for (const gathering of [settings.gatherings?.active, ...(settings.gatherings?.history || [])]) {
    if (!gathering?.id || seen.has(gathering.id)) continue;
    seen.add(gathering.id);
    items.push(gathering);
  }
  return items;
}

function pickGatheringForEvent(settings, event) {
  const eventAt = new Date(event.startedAt).getTime();
  if (!eventAt) return { main: [], bench: [] };

  let best = null;
  let bestDiff = Infinity;
  for (const gathering of listKnownGatherings(settings)) {
    const at = gatheringMoment(gathering);
    if (!at) continue;
    const diff = Math.abs(at - eventAt);
    if (diff < bestDiff) {
      best = gathering;
      bestDiff = diff;
    }
  }
  if (best && bestDiff <= MATCH_WINDOW_MS) return best;
  return { main: [], bench: [] };
}

function ourSidePlayers(event) {
  if (isOurFamily(event.attackerName)) return event.attackers || [];
  if (isOurFamily(event.defenderName)) return event.defenders || [];
  return [];
}

function extraLine(item) {
  if (item.kind === 'reserve') return `${item.charName} · <@${item.member.id}> — из резерва`;
  if (item.kind === 'unlisted') return `${item.charName} · <@${item.member.id}> — не из списка`;
  return `${item.charName} — никто не привязан к участнику`;
}

function rosterLine(guild, player, index, preferredIds) {
  const member = findMember(guild, player.charName, preferredIds);
  return member
    ? `${index + 1}. <@${member.id}> · ${player.charName}`
    : `${index + 1}. ${player.charName}`;
}

function buildVzpCard(guild, gathering, event, options = {}) {
  const main = gathering.main || [];
  const bench = gathering.bench || [];
  const mainSet = new Set(main);
  const benchSet = new Set(bench);
  const preferredIds = new Set([...main, ...bench]);
  const inTerra = ourSidePlayers(event);
  const inTerraIds = new Set();
  const extras = [];

  for (const player of inTerra) {
    const member = findMember(guild, player.charName, preferredIds);
    if (member && mainSet.has(member.id)) {
      inTerraIds.add(member.id);
    } else if (member && benchSet.has(member.id)) {
      inTerraIds.add(member.id);
      extras.push({ charName: player.charName, member, kind: 'reserve' });
    } else if (member) {
      inTerraIds.add(member.id);
      extras.push({ charName: player.charName, member, kind: 'unlisted' });
    } else {
      extras.push({ charName: player.charName, member: null, kind: 'unbound' });
    }
  }

  const missedMain = main.filter((userId) => !inTerraIds.has(userId));
  const weAttack = isOurFamily(event.attackerName);
  const opponent = weAttack ? event.defenderName : event.attackerName;
  const finished = event.isAttackerWin !== null && event.isAttackerWin !== undefined;
  const weWon = finished && isOurFamily(event.winnerName);
  const side = weAttack ? 'Атака' : 'Защита';
  const place = mapName(event.map);
  const title = finished
    ? `${weWon ? '🏆 ПОБЕДА' : '❌ ПОРАЖЕНИЕ'} — ${place} (${side})`
    : `⏳ В ПРОЦЕССЕ — ${place} (${side})`;
  const maxPlayers = event.maxPlayers || inTerra.length || gathering.maxMain || 0;
  const gatheringLine = gathering.id
    ? `Сбор: **${gathering.title || gathering.content || 'сбор'}**` +
      (gathering.threadId ? ` · ветка: <#${gathering.threadId}>` : '')
    : 'Сбор не найден по времени этого матча';

  const notes = [];
  if (extras.length) {
    notes.push(`**Зашли не из списка (${extras.length})**`);
    notes.push(...extras.map(extraLine));
  }
  if (missedMain.length) {
    notes.push(`Из основы не зашли: **${missedMain.length}**`);
  }

  const roster = inTerra.length
    ? inTerra.map((player, index) => rosterLine(guild, player, index, preferredIds)).join('\n')
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
          `${gatheringLine}\n` +
          (notes.length ? `\n${notes.join('\n')}\n` : '\n') +
          `\n**Состав ${inTerra.length}/${maxPlayers}** · ${finished ? 'Завершён' : 'Идёт'}\n` +
          `${roster}`,
        4000,
      ),
    )
    .addFields({
      name: `Резерв · ${bench.length}`,
      value: truncate(reserve, 1024),
    });

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

async function publishManualVzpStats(client, guildId, eventId) {
  const settings = store.getGuild(guildId);
  const channelId = settings.gatherings?.statsChannelId;
  if (!channelId) throw new Error('no-channel');

  const event = await getEvent(eventId);
  if (!event) throw new Error('no-event');

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('no-channel');

  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch().catch(() => null);
  const gathering = pickGatheringForEvent(settings, event);
  return channel.send(buildVzpCard(guild, gathering, event, { manual: true }));
}

async function showVzpDatePicker(interaction) {
  if (!store.getGuild(interaction.guildId).gatherings?.statsChannelId) {
    return interaction.reply({
      content: 'Сначала выбери канал VZP-статы в этой вкладке.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let events;
  try {
    events = await listFamilyEvents();
  } catch (error) {
    return interaction.reply({
      content: `Не удалось взять стату с сайта: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const days = [...new Set(events.map((event) => eventDay(event.startedAt)))];
  if (!days.length) {
    return interaction.reply({
      content: 'На сайте нет матчей RiseFam Chiliad.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (days.length === 1) {
    return showVzpEventPicker(interaction, days[0], events, { reply: true });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('admin:vzpdate')
    .setPlaceholder('За какое число вывести стату?')
    .addOptions(
      days.slice(0, 25).map((day) => {
        const count = events.filter((event) => eventDay(event.startedAt) === day).length;
        return new StringSelectMenuOptionBuilder()
          .setLabel(formatDayLabel(day))
          .setDescription(`${count} матч.`)
          .setValue(day);
      }),
    );

  return interaction.reply({
    content: 'Тест статы VZP. Сначала выбери число.',
    components: [new ActionRowBuilder().setComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showVzpEventPicker(interaction, day, events, options = {}) {
  const list = (events || (await listFamilyEvents())).filter(
    (event) => eventDay(event.startedAt) === day,
  );
  if (!list.length) {
    const payload = {
      content: `За ${formatDayLabel(day)} матчей RiseFam нет.`,
      components: [],
    };
    return options.reply
      ? interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
      : interaction.update(payload);
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('admin:vzpevent')
    .setPlaceholder(`Какой матч за ${formatDayLabel(day)}?`)
    .addOptions(
      list.slice(0, 25).map((event) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(eventOptionLabel(event))
          .setDescription(truncate(`${event.maxPlayers || '?'} чел. · ${event.pointName || 'карта'}`, 100))
          .setValue(event.eventId),
      ),
    );

  const payload = {
    content: `Число **${formatDayLabel(day)}**. Выбери матч — стату уйдёт в канал VZP.`,
    components: [new ActionRowBuilder().setComponents(menu)],
  };
  return options.reply
    ? interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
    : interaction.update(payload);
}

async function handleVzpDatePick(interaction) {
  const day = interaction.values[0];
  try {
    return await showVzpEventPicker(interaction, day);
  } catch (error) {
    return interaction.update({
      content: `Не удалось взять стату с сайта: ${error.message}`,
      components: [],
    });
  }
}

async function handleVzpEventPick(interaction) {
  try {
    await publishManualVzpStats(interaction.client, interaction.guildId, interaction.values[0]);
  } catch (error) {
    const text =
      error.message === 'no-channel'
        ? 'Сначала выбери канал VZP-статы.'
        : error.message === 'no-event'
          ? 'Этот матч на сайте уже не найден.'
          : `Не удалось вывести стату: ${error.message}`;
    return interaction.update({ content: text, components: [] });
  }

  return interaction.update({
    content: 'Тестовая стата отправлена в канал VZP.',
    components: [],
  });
}

module.exports = {
  publishVzpStats,
  refreshVzpStats,
  showVzpDatePicker,
  handleVzpDatePick,
  handleVzpEventPick,
};
