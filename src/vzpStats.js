const {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const store = require('./store');
const { truncate } = require('./util');

const API = 'https://vzp-gta5rp.com/api';
const FAMILY_ID = 170721;
const FAMILY_NAME = 'Trapaholic';
const FAMILY_ALIASES = ['Trapaholic', 'TRAPA', 'RiseFam'].map(normalizeNick);
const SERVER_ID = 25;
const MATCH_MS = 2 * 60 * 60 * 1000;
const MATCH_AFTER_START_MS = 45 * 60 * 1000;
const NO_GATHERING_WAIT_MS = 20 * 60 * 1000;
const POLL_MS = 30 * 1000;
const RECENT_MS = 6 * 60 * 60 * 1000;
let scanning = false;

const MAP_NAMES = {
  NEW_B_GHETTO_ANTS: 'Муравейник',
  NEW_S_GHETTO_ANTS: 'Муравейник',
  NEW_S_SANDYSHORES: 'Сэнди-Шорс',
  NEW_S_WINDFARM: 'Ветряки',
  NEW_S_ELBURRO: 'Эль-Бурро',
  NEW_S_STABCITY: 'Стаб-Сити',
  NEW_S_BANNING_ANGAR: 'Ангар',
  NEW_B_LS_CINEMA: 'Киностудия',
  NEW_S_EL_RANCHO_SMALL_OILBASE: 'Нефтебаза',
  NEW_S_PUERTA_DUMP: 'Мусорка',
};

function mapName(code) {
  return MAP_NAMES[code] || code || 'карта';
}

function mapTitle(event) {
  const title = event?.mapLabel || event?.pointName || mapName(event?.map);
  return String(title || 'карта').split(/\s+[—-]\s+/).pop() || title || 'карта';
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
    `/stats/organizations/${FAMILY_ID}/history?limit=${limit}&offset=0`,
  );
  return (Array.isArray(events) ? events : []).map((event) => {
    const attack = event.role === 'ATK';
    const opponent = event.opponentName || '—';
    return {
      ...event,
      serverId: SERVER_ID,
      startedAt: event.startedAt || event.date,
      mapLabel: event.map,
      pointName: event.map,
      attackerName: attack ? FAMILY_NAME : opponent,
      defenderName: attack ? opponent : FAMILY_NAME,
      winnerName: event.isWin ? FAMILY_NAME : opponent,
      _role: attack ? 'attack' : 'defense',
    };
  });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function readKyivParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second') || 0,
  };
}

function kyivOffsetMs(instant) {
  const parts = readKyivParts(instant);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
}

function kyivWallToUtc(year, month, day, hour, minute, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const utc = guess - kyivOffsetMs(guess);
  const check = readKyivParts(utc);
  if (check.hour === hour && check.day === day && check.minute === minute) return utc;
  return guess - kyivOffsetMs(utc);
}

function vzpWallParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] || 0),
    };
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : readKyivParts(ms);
}

function eventClockAt(event) {
  const parts = vzpWallParts(event?.startedAt || event?.date);
  if (!parts) return 0;
  return kyivWallToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

function eventDay(startedAt) {
  const parts = vzpWallParts(startedAt);
  if (!parts) return '';
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function formatDayLabel(day) {
  const [year, month, date] = String(day).split('-');
  return `${date}.${month}.${year}`;
}

function formatEventTime(startedAt) {
  const parts = vzpWallParts(startedAt);
  if (!parts) return '—';
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function formatEventWhen(startedAt) {
  if (!startedAt) return '—';
  return `${formatDayLabel(eventDay(startedAt))} в ${formatEventTime(startedAt)}`;
}

function opponentName(event) {
  if (event?._role === 'attack') return event.defenderName;
  if (event?._role === 'defense') return event.attackerName;
  return isOurFamily(event.attackerName) ? event.defenderName : event.attackerName;
}

function eventOptionLabel(event) {
  const mark = !eventFinished(event) ? 'идёт' : isOurFamily(event.winnerName) ? 'W' : 'L';
  return truncate(
    `${formatEventTime(event.startedAt)} ${mark} vs ${opponentName(event) || '—'} · ${mapTitle(event)}`,
    100,
  );
}

async function getEvent(eventId) {
  const event = await fetchJson(`/events/${eventId}`);
  return event && !event.error ? event : null;
}

function isOurFamily(name) {
  return FAMILY_ALIASES.includes(normalizeNick(name));
}

function eventSide(event) {
  if (event?._role) return event._role;
  if (isOurFamily(event?.attackerName)) return 'attack';
  if (isOurFamily(event?.defenderName)) return 'defense';
  return null;
}

function gatheringSide(gathering) {
  const text = String(`${gathering?.content || ''} ${gathering?.title || ''}`)
    .toLowerCase()
    .replace(/ё/g, 'е');
  const attackAt = text.search(/\batt\b|атт|аттаск/);
  const defenseAt = text.search(/\bdeff\b|дефф/);
  if (attackAt === -1 && defenseAt === -1) return null;
  if (attackAt === -1) return 'defense';
  if (defenseAt === -1) return 'attack';
  return attackAt <= defenseAt ? 'attack' : 'defense';
}

function gatheringMoment(gathering) {
  return Number(gathering?.timeAt || gathering?.closedAt || gathering?.startedAt || 0);
}

function withinMatchWindow(eventAt, gatheringAt) {
  const diff = eventAt - gatheringAt;
  return diff >= -MATCH_AFTER_START_MS && diff <= MATCH_MS;
}

function pickLatestGathering(gatherings, eventAt) {
  let best = null;
  let bestAt = -1;
  for (const gathering of gatherings) {
    const gatheringAt = gatheringMoment(gathering);
    if (!gatheringAt || !withinMatchWindow(eventAt, gatheringAt)) continue;
    if (gatheringAt >= bestAt) {
      best = gathering;
      bestAt = gatheringAt;
    }
  }
  return best;
}

function cleanName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

function compactName(name) {
  return cleanName(name).replace(/\s+/g, '');
}

function nameTokens(name) {
  return cleanName(name)
    .split(/\s+/)
    .filter((token) => token && !['trapaholic', 'rise', 'risefam', 'trapa'].includes(token));
}

function tokensClose(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

function scoreName(charName, source) {
  const left = compactName(charName);
  const right = compactName(source);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return 88;

  const a = nameTokens(charName);
  const b = nameTokens(source);
  if (!a[0] || !b[0]) return 0;
  const first = tokensClose(a[0], b[0]);
  const second = a[1] && b[1] ? tokensClose(a[1], b[1]) : false;
  if (first && second) return 92;
  if (first && !a[1] && !b[1]) return 86;
  if (first && (a.length === 1 || b.length === 1)) return 74;
  return 0;
}

function scoreMember(charName, member) {
  return Math.max(
    0,
    ...[member.displayName, member.user?.globalName, member.user?.username]
      .filter(Boolean)
      .map((source) => scoreName(charName, source)),
  );
}

function bestMember(charName, members, minScore) {
  let best = null;
  let bestScore = 0;
  for (const member of members) {
    const score = scoreMember(charName, member);
    if (score > bestScore) {
      best = member;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? best : null;
}

function findMember(guild, player, preferredIds = null) {
  const charName = typeof player === 'string' ? player : player?.charName;
  if (!compactName(charName)) return null;

  const roster = preferredIds
    ? [...preferredIds].map((id) => guild.members.cache.get(id)).filter(Boolean)
    : [];
  const fromRoster = bestMember(charName, roster, 70);
  if (fromRoster) return fromRoster;

  const others = guild.members.cache.filter((member) => !preferredIds?.has(member.id));
  return bestMember(charName, others.values(), 86);
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
  const eventAt = eventClockAt(event);
  const actual = eventSide(event);
  if (!eventAt || !actual) return { main: [], bench: [] };

  const sameSide = listKnownGatherings(settings).filter((gathering) => {
    if (gatheringSide(gathering) !== actual) return false;
    if (gathering.vzpEventId && gathering.vzpEventId !== event.eventId) return false;
    return true;
  });
  return pickLatestGathering(sameSide, eventAt) || { main: [], bench: [] };
}

function ourSidePlayers(event) {
  if (event?._role === 'attack') return event.attackers || [];
  if (event?._role === 'defense') return event.defenders || [];
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
  const member = findMember(guild, player, preferredIds);
  return member
    ? `${index + 1}. <@${member.id}> · ${player.charName}`
    : `${index + 1}. ${player.charName}`;
}

function buildVzpCard(guild, gathering, event, options = {}) {
  gathering = gathering || {};
  const hasGathering = Boolean(gathering?.id);
  const main = gathering.main || [];
  const bench = gathering.bench || [];
  const mainSet = new Set(main);
  const benchSet = new Set(bench);
  const preferredIds = new Set([...main, ...bench]);
  const inTerra = ourSidePlayers(event);
  const inTerraIds = new Set();
  const extras = [];

  for (const player of inTerra) {
    const member = findMember(guild, player, preferredIds);
    if (!hasGathering) {
      if (member) inTerraIds.add(member.id);
    } else if (member && mainSet.has(member.id)) {
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
  const place = mapTitle(event);
  const title = finished
    ? `${weWon ? '🏆 ПОБЕДА' : '❌ ПОРАЖЕНИЕ'} — ${place} (${side})`
    : `⏳ В ПРОЦЕССЕ — ${place} (${side})`;
  const maxPlayers = event.maxPlayers || inTerra.length || gathering.maxMain || 0;
  const gatheringUrl =
    guild?.id && gathering.channelId && gathering.messageId
      ? `https://discord.com/channels/${guild.id}/${gathering.channelId}/${gathering.messageId}`
      : guild?.id && gathering.threadId
        ? `https://discord.com/channels/${guild.id}/${gathering.threadId}`
        : null;
  const gatheringLine = hasGathering
    ? `Сбор: **${gathering.title || gathering.content || 'сбор'}**` +
      (gatheringUrl ? ` · [открыть](${gatheringUrl})` : '') +
      (gathering.threadId ? ` · ветка: <#${gathering.threadId}>` : '')
    : '**На эту ВЗП не было сбора.**';

  const notes = [];
  if (extras.length) {
    notes.push(`**Зашли не из списка (${extras.length})**`);
    notes.push(...extras.map(extraLine));
  }
  if (missedMain.length) {
    notes.push(`Из основы не зашли: **${missedMain.length}**`);
  }
  if (!hasGathering) {
    notes.push('Бот не нашёл подходящий сбор `att/deff` в допустимом окне.');
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
          `Когда: **${formatEventWhen(event.startedAt)}**\n` +
          `${gatheringLine}\n` +
          (notes.length ? `\n${notes.join('\n')}\n` : '\n') +
          `\n**Состав ${inTerra.length}/${maxPlayers}** · ${finished ? 'Завершён' : 'Идёт'}\n` +
          `${roster}`,
        4000,
      ),
    );
  if (hasGathering) {
    embed.addFields({
      name: `Резерв · ${bench.length}`,
      value: truncate(reserve, 1024),
    });
  }

  return {
    embeds: [embed],
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
  patchGathering(guildId, gathering.id, { statsMessageId: message.id });
  gathering.statsMessageId = message.id;
  return message;
}

function findGatheringById(settings, gatheringId) {
  if (!gatheringId) return null;
  const active = settings.gatherings?.active;
  if (active?.id === gatheringId) return active;
  return (settings.gatherings?.history || []).find((item) => item.id === gatheringId) || null;
}

function patchGathering(guildId, gatheringId, patch) {
  if (!gatheringId) return;
  store.updateGuild(guildId, (guild) => {
    const apply = (item) => {
      if (item?.id === gatheringId) Object.assign(item, patch);
    };
    apply(guild.gatherings?.active);
    for (const item of guild.gatherings?.history || []) apply(item);
  });
}

function eventFinished(event) {
  if (!event?.eventId) return false;
  if (event.endedAt) return true;
  if (event.isWin === true || event.isWin === false) return true;
  return event.isAttackerWin === true || event.isAttackerWin === false;
}

function eventEndedAt(event) {
  if (event?.endedAt) return new Date(event.endedAt).getTime() || 0;
  if (eventFinished(event) && event.startedAt) return new Date(event.startedAt).getTime() || 0;
  return 0;
}

function boundEventIds(settings) {
  const ids = new Set();
  for (const item of listKnownGatherings(settings)) {
    if (item?.vzpEventId) ids.add(item.vzpEventId);
  }
  return ids;
}

function saveWatch(guildId, watch) {
  const entries = Object.entries(watch.events || {});
  let events = watch.events || {};
  if (entries.length > 300) {
    entries.sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
    events = Object.fromEntries(entries.slice(-200));
  }
  store.updateGuild(guildId, (guild) => {
    guild.gatherings.vzpWatch = { seeded: Boolean(watch.seeded), events };
  });
}

async function refreshVzpStats(client, guildId, gatheringId) {
  const settings = store.getGuild(guildId);
  const gathering = findGatheringById(settings, gatheringId);
  if (!gathering?.vzpEventId || !settings.gatherings?.statsChannelId) return null;
  gathering._guildId = guildId;

  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch().catch(() => null);

  try {
    const event = await getEvent(gathering.vzpEventId);
    if (!event) return null;
    await sendOrEditCard(client, gathering, buildVzpCard(guild, gathering, event));
    return event;
  } catch (error) {
    console.warn('Не удалось обновить стату VZP:', error.message);
    return null;
  }
}

async function sendStandaloneCard(client, guildId, gathering, event) {
  const channelId = getStatsChannelId(guildId);
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel?.isTextBased()) return null;

  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch().catch(() => null);
  if (gathering?.id) {
    gathering._guildId = guildId;
    const message = await sendOrEditCard(client, gathering, buildVzpCard(guild, gathering, event));
    if (message) {
      patchGathering(guildId, gathering.id, {
        vzpEventId: event.eventId,
        statsMessageId: message.id,
      });
    }
    return message;
  }

  return channel.send(buildVzpCard(guild, { _guildId: guildId }, event));
}

async function scanGuild(client, guildId) {
  const settings = store.getGuild(guildId);
  if (!settings.gatherings?.statsChannelId) return;

  let events;
  try {
    events = await listFamilyEvents();
  } catch (error) {
    console.warn('Не удалось проверить ВЗП:', error.message);
    return;
  }

  const watch = {
    seeded: Boolean(settings.gatherings.vzpWatch?.seeded),
    events: { ...(settings.gatherings.vzpWatch?.events || {}) },
  };
  const bound = boundEventIds(settings);
  let changed = false;

  for (const event of events) {
    if (!eventFinished(event)) continue;
    const prev = watch.events[event.eventId];
    if (prev?.status === 'done' || prev?.status === 'skip') continue;
    if (bound.has(event.eventId)) {
      watch.events[event.eventId] = { status: 'done', at: Date.now() };
      changed = true;
      continue;
    }

    if (prev?.status === 'prompt' && prev.messageId && prev.channelId) {
      const channel = await client.channels.fetch(prev.channelId).catch(() => null);
      const message = channel?.isTextBased()
        ? await channel.messages.fetch(prev.messageId).catch(() => null)
        : null;
      await message?.delete().catch(() => null);
    }

    const ended = eventEndedAt(event);
    if (!watch.seeded) {
      if (!ended || Date.now() - ended > RECENT_MS) {
        watch.events[event.eventId] = { status: 'skip', at: Date.now() };
        changed = true;
        continue;
      }
    }

    const detailRaw = await getEvent(event.eventId).catch(() => null);
    const detail = detailRaw
      ? {
          ...event,
          ...detailRaw,
          _role: event._role,
          mapLabel: event.mapLabel,
          endedAt: detailRaw.endedAt || event.endedAt,
          isAttackerWin:
            detailRaw.isAttackerWin === true || detailRaw.isAttackerWin === false
              ? detailRaw.isAttackerWin
              : event.isAttackerWin,
          isWin: detailRaw.isWin === true || detailRaw.isWin === false ? detailRaw.isWin : event.isWin,
        }
      : event;
    if (!eventFinished(detail) && !eventFinished(event)) continue;

    const currentSettings = store.getGuild(guildId);
    const gathering = pickGatheringForEvent(currentSettings, detail);
    const hasGathering = Boolean(gathering?.id);
    const detailEnded = eventEndedAt(detail);
    if (!hasGathering && (!detailEnded || Date.now() - detailEnded < NO_GATHERING_WAIT_MS)) {
      continue;
    }

    const message = await sendStandaloneCard(
      client,
      guildId,
      hasGathering ? gathering : null,
      detail,
    ).catch((error) => {
      console.warn('Не удалось отправить стату VZP:', error.message);
      return null;
    });
    if (!message) continue;
    watch.events[event.eventId] = {
      status: 'done',
      messageId: message.id,
      channelId: message.channelId,
      gatheringId: hasGathering ? gathering.id : null,
      noGathering: !hasGathering,
      at: Date.now(),
    };
    changed = true;
  }

  if (!watch.seeded) {
    watch.seeded = true;
    changed = true;
  }

  if (changed) saveWatch(guildId, watch);
}

async function scanVzpMatches(client) {
  if (scanning) return;
  scanning = true;
  try {
    for (const guildId of store.getGuildIds()) {
      await scanGuild(client, guildId);
    }
  } finally {
    scanning = false;
  }
}

function setupVzpWatch(client) {
  client.once(Events.ClientReady, () => {
    scanVzpMatches(client).catch((error) => {
      console.warn('Не удалось проверить ВЗП:', error.message);
    });
    const timer = setInterval(() => {
      scanVzpMatches(client).catch((error) => {
        console.warn('Не удалось проверить ВЗП:', error.message);
      });
    }, POLL_MS);
    timer.unref?.();
  });
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
      content: 'На сайте нет матчей Trapaholic Chiliad.',
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
      content: `За ${formatDayLabel(day)} матчей Trapaholic нет.`,
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
  refreshVzpStats,
  setupVzpWatch,
  showVzpDatePicker,
  handleVzpDatePick,
  handleVzpEventPick,
};
