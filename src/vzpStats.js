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
const FAMILY_NAME = 'RiseFam';
const SERVER_ID = 25;
const MATCH_BEFORE_MS = 45 * 60 * 1000;
const MATCH_AFTER_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 30 * 1000;
const RECENT_MS = 6 * 60 * 60 * 1000;
const PICK_PREFIX = 'vzp:pick:';
const MENU_VERSION = 2;
let scanning = false;
const picksInFlight = new Set();

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

function formatEventWhen(startedAt) {
  if (!startedAt) return '—';
  return `${formatDayLabel(eventDay(startedAt))} в ${formatEventTime(startedAt)}`;
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

function eventSide(event) {
  if (isOurFamily(event?.attackerName)) return 'attack';
  if (isOurFamily(event?.defenderName)) return 'defense';
  return null;
}

function gatheringSide(gathering) {
  const text = String(`${gathering?.content || ''} ${gathering?.title || ''}`)
    .toLowerCase()
    .replace(/ё/g, 'е');
  const attackAt = text.search(/аттаск|атт|att/);
  const defenseAt = text.search(/дефф|deff/);
  if (attackAt === -1 && defenseAt === -1) return null;
  if (attackAt === -1) return 'defense';
  if (defenseAt === -1) return 'attack';
  return attackAt <= defenseAt ? 'attack' : 'defense';
}

function gatheringMoment(gathering) {
  return Number(gathering?.timeAt || gathering?.closedAt || gathering?.startedAt || 0);
}

function sideMatches(gathering, event) {
  const wanted = gatheringSide(gathering);
  const actual = eventSide(event);
  if (!wanted || !actual) return true;
  return wanted === actual;
}

function withinMatchWindow(eventAt, gatheringAt) {
  const diff = eventAt - gatheringAt;
  return diff >= -MATCH_BEFORE_MS && diff <= MATCH_AFTER_MS;
}

function pickClosestGathering(gatherings, eventAt) {
  let best = null;
  let bestDiff = Infinity;
  for (const gathering of gatherings) {
    const gatheringAt = gatheringMoment(gathering);
    if (!gatheringAt || !withinMatchWindow(eventAt, gatheringAt)) continue;
    const diff = Math.abs(eventAt - gatheringAt);
    if (diff < bestDiff) {
      best = gathering;
      bestDiff = diff;
    }
  }
  return best;
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
  const actual = eventSide(event);
  if (!eventAt || !actual) return { main: [], bench: [] };

  const labeled = [];
  const unlabeled = [];
  for (const gathering of listKnownGatherings(settings)) {
    const wanted = gatheringSide(gathering);
    if (wanted && wanted !== actual) continue;
    if (wanted === actual) labeled.push(gathering);
    else unlabeled.push(gathering);
  }

  return (
    pickClosestGathering(labeled, eventAt) ||
    pickClosestGathering(unlabeled, eventAt) || { main: [], bench: [] }
  );
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
          `Когда: **${formatEventWhen(event.startedAt)}**\n` +
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
  return event.isAttackerWin === true || event.isAttackerWin === false;
}

function eventEndedAt(event) {
  if (event?.endedAt) return new Date(event.endedAt).getTime() || 0;
  if (eventFinished(event) && event.startedAt) return new Date(event.startedAt).getTime() || 0;
  return 0;
}

function listPickableGatherings(settings) {
  const items = [];
  const seen = new Set();
  const active = settings.gatherings?.active;
  if (active?.id) {
    seen.add(active.id);
    items.push({ ...active, open: !active.closed });
  }
  for (const item of settings.gatherings?.history || []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  items.sort(
    (a, b) =>
      (b.timeAt || b.closedAt || b.startedAt || 0) - (a.timeAt || a.closedAt || a.startedAt || 0),
  );
  return items.slice(0, 25);
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

function gatheringChoiceLabel(gathering) {
  const at = gathering.timeAt || gathering.startedAt || gathering.closedAt;
  const when = at ? `${formatDayLabel(eventDay(at))} ${formatEventTime(at)}` : '—';
  return truncate(`${when} · ${gathering.content || gathering.title || 'сбор'}`, 100);
}

function buildGatheringMenu(guildId, eventId) {
  const gatherings = listPickableGatherings(store.getGuild(guildId));
  if (!gatherings.length) return null;
  if (`${PICK_PREFIX}${eventId}`.length > 100) return null;
  return new StringSelectMenuBuilder()
    .setCustomId(`${PICK_PREFIX}${eventId}`)
    .setPlaceholder('Какой сбор к этому ВЗП?')
    .addOptions(
      gatherings.map((gathering) => {
        const count = `${(gathering.main || []).length}/${gathering.maxMain || '—'}`;
        const state = gathering.open ? 'открыт' : 'закрыт';
        return new StringSelectMenuOptionBuilder()
          .setLabel(gatheringChoiceLabel(gathering))
          .setDescription(truncate(`${state} · основа ${count}`, 100))
          .setValue(gathering.id);
      }),
    );
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

async function sendPickPanel(client, guildId, event) {
  const channelId = getStatsChannelId(guildId);
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const menu = buildGatheringMenu(guildId, event.eventId);
  if (!menu) {
    if (`${PICK_PREFIX}${event.eventId}`.length > 100) {
      console.warn('Слишком длинный id матча VZP, панель не отправлена.');
    }
    return null;
  }

  const weAttack = isOurFamily(event.attackerName);
  const opponent = weAttack ? event.defenderName : event.attackerName;
  const finished = event.isAttackerWin === true || event.isAttackerWin === false;
  const weWon = finished && isOurFamily(event.winnerName);
  const side = weAttack ? 'Атака' : 'Защита';
  const result = finished ? (weWon ? 'Победа' : 'Поражение') : 'Завершён';
  const place = event.pointName || mapName(event.map);

  return channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(finished ? (weWon ? 0x57f287 : 0xed4245) : 0xfee75c)
        .setTitle('ВЗП закончилось — выбери сбор')
        .setDescription(
          truncate(
            `**${FAMILY_NAME}** vs **${opponent || '—'}**\n` +
              `${side} · ${place}\n` +
              `Когда: **${formatEventWhen(event.startedAt)}**\n` +
              `Итог: **${result}**\n\n` +
              `Выбери сбор, к которому относится этот матч.\n` +
              `После выбора придёт стата, а эта панель удалится.`,
            4000,
          ),
        ),
    ],
    components: [new ActionRowBuilder().setComponents(menu)],
    allowedMentions: { parse: [] },
  });
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
  const pending = [];
  let changed = false;

  for (const event of events) {
    if (!eventFinished(event)) continue;
    const prev = watch.events[event.eventId];
    if (prev?.status === 'prompt') {
      if (prev.menuVersion !== MENU_VERSION && prev.messageId && prev.channelId) {
        const channel = await client.channels.fetch(prev.channelId).catch(() => null);
        const message = channel?.isTextBased()
          ? await channel.messages.fetch(prev.messageId).catch(() => null)
          : null;
        const menu = message ? buildGatheringMenu(guildId, event.eventId) : null;
        if (menu) {
          const edited = await message
            .edit({ components: [new ActionRowBuilder().setComponents(menu)] })
            .catch(() => null);
          if (edited) {
            watch.events[event.eventId] = { ...prev, menuVersion: MENU_VERSION };
            changed = true;
          }
        }
      }
      continue;
    }
    if (prev?.status === 'done' || prev?.status === 'skip') continue;
    if (bound.has(event.eventId)) {
      watch.events[event.eventId] = { status: 'done', at: Date.now() };
      changed = true;
      continue;
    }
    if (!watch.seeded) {
      const ended = eventEndedAt(event);
      if (!ended || Date.now() - ended > RECENT_MS) {
        watch.events[event.eventId] = { status: 'skip', at: Date.now() };
        changed = true;
        continue;
      }
    }
    pending.push(event);
  }

  if (!watch.seeded) {
    watch.seeded = true;
    changed = true;
  }

  for (const event of pending) {
    const message = await sendPickPanel(client, guildId, event).catch((error) => {
      console.warn('Не удалось отправить панель выбора сбора:', error.message);
      return null;
    });
    if (!message) continue;
    watch.events[event.eventId] = {
      status: 'prompt',
      messageId: message.id,
      channelId: message.channelId,
      menuVersion: MENU_VERSION,
      at: Date.now(),
    };
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

async function handleVzpGatheringPick(interaction) {
  const eventId = interaction.customId.slice(PICK_PREFIX.length);
  const gatheringId = interaction.values[0];
  const lockKey = `${interaction.guildId}:${eventId}`;
  if (picksInFlight.has(lockKey)) {
    return interaction.reply({
      content: 'Этот матч уже привязывают.',
      flags: MessageFlags.Ephemeral,
    });
  }
  picksInFlight.add(lockKey);

  try {
    const settings = store.getGuild(interaction.guildId);
    if (settings.gatherings?.vzpWatch?.events?.[eventId]?.status === 'done') {
      await interaction.reply({
        content: 'К этому матчу сбор уже выбран.',
        flags: MessageFlags.Ephemeral,
      });
      await interaction.message.delete().catch(() => null);
      return;
    }

    const gathering = findGatheringById(settings, gatheringId);
    if (!gathering) {
      return interaction.reply({
        content: 'Этот сбор уже не найден. Выбери другой.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferUpdate();
    const event = await getEvent(eventId);
    if (!event) {
      await interaction.message.edit({
        content: 'Этот матч на сайте уже не найден.',
        components: interaction.message.components,
      }).catch(() => null);
      return;
    }

    const channelId = getStatsChannelId(interaction.guildId);
    const channel = channelId
      ? await interaction.client.channels.fetch(channelId).catch(() => null)
      : null;
    if (!channel?.isTextBased()) {
      await interaction.message.edit({
        content: 'Канал VZP-статы не выбран.',
        components: interaction.message.components,
      }).catch(() => null);
      return;
    }

    const guild = await interaction.client.guilds.fetch(interaction.guildId);
    await guild.members.fetch().catch(() => null);
    gathering._guildId = interaction.guildId;
    const message = await channel.send(buildVzpCard(guild, gathering, event));
    patchGathering(interaction.guildId, gathering.id, {
      vzpEventId: event.eventId || eventId,
      statsMessageId: message.id,
    });
    store.updateGuild(interaction.guildId, (guildSettings) => {
      if (!guildSettings.gatherings.vzpWatch) {
        guildSettings.gatherings.vzpWatch = { seeded: true, events: {} };
      }
      guildSettings.gatherings.vzpWatch.seeded = true;
      if (!guildSettings.gatherings.vzpWatch.events) guildSettings.gatherings.vzpWatch.events = {};
      guildSettings.gatherings.vzpWatch.events[eventId] = {
        status: 'done',
        messageId: message.id,
        gatheringId: gathering.id,
        at: Date.now(),
      };
    });
    await interaction.message.delete().catch(() => null);
  } catch (error) {
    console.warn('Не удалось привязать сбор к ВЗП:', error.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.message.edit({
        content: `Не удалось отправить стату: ${error.message}`,
        components: interaction.message.components,
      }).catch(() => null);
    } else {
      await interaction.reply({
        content: `Не удалось отправить стату: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }
  } finally {
    picksInFlight.delete(lockKey);
  }
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
  refreshVzpStats,
  setupVzpWatch,
  handleVzpGatheringPick,
  showVzpDatePicker,
  handleVzpDatePick,
  handleVzpEventPick,
};
