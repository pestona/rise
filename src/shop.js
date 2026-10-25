const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ChannelType,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const store = require('./store');
const { canReview, isHttpUrl, shortId, truncate } = require('./util');
const {
  buildShopPanel,
  buildShopBalance,
  buildShopReportCatalog,
  buildShopReportReview,
  buildShopPurchaseReview,
  buildShopReportNotice,
  v2Flags,
} = require('./ui');
const { getUserVoiceMs, listVoiceUserIds } = require('./activity');

const FILE = path.join(__dirname, '..', 'data', 'shop.json');
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
  }, 800);
  saveTimer.unref?.();
}

function guildData(guildId) {
  const guild = (db.guilds[guildId] ||= {
    balances: {},
    creditedVoiceMs: {},
    selectedItemId: {},
    reports: [],
    purchases: [],
  });
  guild.balances ||= {};
  guild.creditedVoiceMs ||= {};
  guild.selectedItemId ||= {};
  guild.reports ||= [];
  guild.purchases ||= [];
  return guild;
}

function getBalance(guildId, userId) {
  return Math.max(0, Math.floor(Number(guildData(guildId).balances[userId] || 0)));
}

function setBalance(guildId, userId, value) {
  const data = guildData(guildId);
  data.balances[userId] = Math.max(0, Math.floor(Number(value) || 0));
  saveSoon();
  return data.balances[userId];
}

function addBalance(guildId, userId, delta) {
  return setBalance(guildId, userId, getBalance(guildId, userId) + delta);
}

function listBalances(guildId) {
  creditVoicePoints(guildId);
  return Object.entries(guildData(guildId).balances)
    .map(([userId, value]) => ({
      userId,
      balance: Math.max(0, Math.floor(Number(value) || 0)),
    }))
    .filter((entry) => entry.balance > 0)
    .sort((a, b) => b.balance - a.balance || a.userId.localeCompare(b.userId));
}

function shopSettings(guildId) {
  return store.getGuild(guildId).shop || {};
}

function shopItems(guildId) {
  return [...(shopSettings(guildId).items || [])];
}

function findItem(guildId, itemId) {
  return shopItems(guildId).find((item) => item.id === itemId) || null;
}

function reportTypes(guildId) {
  return [...(shopSettings(guildId).reportTypes || [])];
}

function findReportType(guildId, typeId) {
  return reportTypes(guildId).find((type) => type.id === typeId) || null;
}

function reportModal(type) {
  return new ModalBuilder()
    .setCustomId(`shop:rmodal:${type.id}`)
    .setTitle(truncate(`Отчёт: ${type.name}`, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('url')
          .setLabel('Ссылка на скрин (imgur / yapx)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(400)
          .setPlaceholder('https://imgur.com/...'),
      ),
    );
}

function creditVoicePoints(guildId) {
  const minutesPerPoint = Number(shopSettings(guildId).voiceMinutesPerPoint || 0);
  if (!minutesPerPoint || minutesPerPoint <= 0) return;
  const needMs = minutesPerPoint * 60_000;
  const data = guildData(guildId);
  let dirty = false;
  for (const userId of listVoiceUserIds(guildId)) {
    const total = getUserVoiceMs(guildId, userId);
    const credited = Number(data.creditedVoiceMs[userId] || 0);
    const gained = Math.floor((total - credited) / needMs);
    if (gained <= 0) continue;
    data.creditedVoiceMs[userId] = credited + gained * needMs;
    data.balances[userId] = getBalance(guildId, userId) + gained;
    dirty = true;
  }
  if (dirty) saveSoon();
}

function panelPayload(settings) {
  return {
    components: [buildShopPanel(settings)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };
}

async function refreshShopPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const payload = panelPayload(settings);
  const dead = [];
  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'shop')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(payload);
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель магазина:', error.message);
    }
  }
  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function publishShopPanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const payload = panelPayload(settings);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === 'shop' && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      store.rememberPanel(interaction.guildId, {
        key: 'shop',
        channelId: channel.id,
        messageId: message.id,
      });
      return { edited: true, message };
    } catch {
      // старое сообщение удалили
    }
  }
  if (channel.type === ChannelType.GuildForum) throw new Error('forum');
  const message = await channel.send(payload);
  store.rememberPanel(interaction.guildId, {
    key: 'shop',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function notifyShopUser(client, userId, kind, extra) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  await user
    .send({
      components: [buildShopReportNotice(kind, extra)],
      flags: v2Flags(false),
      allowedMentions: { parse: [] },
    })
    .catch((error) => console.warn(`Не удалось отправить ЛС магазина ${userId}:`, error.message));
}

async function handleShopSelect(interaction) {
  const item = findItem(interaction.guildId, interaction.values[0]);
  if (!item) {
    return interaction.reply({ content: 'Этот товар уже недоступен.', flags: MessageFlags.Ephemeral });
  }
  guildData(interaction.guildId).selectedItemId[interaction.user.id] = item.id;
  saveSoon();
  return interaction.reply({
    content: `Выбран товар **${item.name}** · **${item.price}** баллов. Нажми **Купить**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleShopButton(interaction) {
  const action = interaction.customId.split(':')[1];
  const settings = store.getGuild(interaction.guildId);
  creditVoicePoints(interaction.guildId);

  if (action === 'balance') {
    return interaction.reply({
      components: [buildShopBalance(settings, getBalance(interaction.guildId, interaction.user.id))],
      flags: v2Flags(true),
      allowedMentions: { parse: [] },
    });
  }

  if (action === 'report') {
    if (!reportTypes(interaction.guildId).length) {
      return interaction.reply({
        content: 'Типы РП-отчётов ещё не настроены.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      components: [buildShopReportCatalog(settings)],
      flags: v2Flags(true),
      allowedMentions: { parse: [] },
    });
  }

  if (action === 'rtype') {
    const type = findReportType(interaction.guildId, interaction.customId.split(':')[2]);
    if (!type) {
      return interaction.reply({ content: 'Этот тип отчёта уже недоступен.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(reportModal(type));
  }

  if (action === 'buy') {
    const itemId = guildData(interaction.guildId).selectedItemId[interaction.user.id];
    const item = findItem(interaction.guildId, itemId);
    if (!item) {
      return interaction.reply({
        content: 'Сначала выбери товар в списке.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const channelId = settings.shop?.purchaseChannelId || settings.shop?.reviewChannelId;
    if (!channelId) {
      return interaction.reply({
        content: 'Канал заявок на покупку не настроен.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const balance = getBalance(interaction.guildId, interaction.user.id);
    if (balance < item.price) {
      return interaction.reply({
        content: `Не хватает баллов. Нужно **${item.price}**, у тебя **${balance}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    const already = guildData(interaction.guildId).purchases.some(
      (entry) => entry.userId === interaction.user.id && entry.itemId === item.id && entry.status === 'pending',
    );
    if (already) {
      return interaction.reply({
        content: 'Эта покупка уже на проверке.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) {
      return interaction.reply({ content: 'Канал заявок на покупку недоступен.', flags: MessageFlags.Ephemeral });
    }

    const next = addBalance(interaction.guildId, interaction.user.id, -item.price);
    const purchase = {
      id: shortId(),
      userId: interaction.user.id,
      itemId: item.id,
      itemName: item.name,
      price: item.price,
      roleId: item.roleId || null,
      status: 'pending',
      createdAt: Date.now(),
    };
    guildData(interaction.guildId).purchases.push(purchase);
    saveSoon();

    const staff = settings.staffRoleIds || [];
    const sent = await channel.send({
      components: [buildShopPurchaseReview(purchase, settings, { staffPing: staff.length })],
      flags: v2Flags(false),
      allowedMentions: { users: [interaction.user.id], roles: staff },
    });
    const stored = guildData(interaction.guildId).purchases.find((entry) => entry.id === purchase.id);
    if (stored) {
      stored.channelId = sent.channelId;
      stored.messageId = sent.id;
      saveSoon();
    }
    return interaction.reply({
      content: `Заявка на **${item.name}** отправлена. Списано **${item.price}**, остаток: **${next}**. Жди решение.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleShopReportModal(interaction) {
  const type = findReportType(interaction.guildId, interaction.customId.split(':')[2]);
  if (!type) {
    return interaction.reply({ content: 'Этот тип отчёта уже недоступен.', flags: MessageFlags.Ephemeral });
  }
  const url = interaction.fields.getTextInputValue('url').trim();
  if (!isHttpUrl(url)) {
    return interaction.reply({ content: 'Нужна обычная http/https ссылка на скрин.', flags: MessageFlags.Ephemeral });
  }

  const settings = store.getGuild(interaction.guildId);
  const channelId = settings.shop?.reviewChannelId;
  if (!channelId) {
    return interaction.reply({ content: 'Канал проверки РП-отчётов не настроен.', flags: MessageFlags.Ephemeral });
  }

  const report = {
    id: shortId(),
    userId: interaction.user.id,
    imageUrl: url,
    typeId: type.id,
    typeName: type.name,
    points: Math.max(0, Math.floor(Number(type.points) || 0)),
    comment: '',
    status: 'pending',
    createdAt: Date.now(),
  };
  guildData(interaction.guildId).reports.push(report);
  saveSoon();

  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) {
    return interaction.reply({ content: 'Канал проверки РП-отчётов недоступен.', flags: MessageFlags.Ephemeral });
  }

  const staff = settings.staffRoleIds || [];
  const sent = await channel.send({
    components: [buildShopReportReview(report, settings, { staffPing: staff.length })],
    flags: v2Flags(false),
    allowedMentions: { users: [interaction.user.id], roles: staff },
  });
  const stored = guildData(interaction.guildId).reports.find((item) => item.id === report.id);
  if (stored) {
    stored.channelId = sent.channelId;
    stored.messageId = sent.id;
    saveSoon();
  }
  return interaction.reply({ content: 'РП-отчёт отправлен на проверку.', flags: MessageFlags.Ephemeral });
}

async function handleShopReview(interaction) {
  const [, decision, reportId] = interaction.customId.split(':');
  const settings = store.getGuild(interaction.guildId);
  if (!canReview(interaction.member, settings)) {
    return interaction.reply({ content: 'Принимать отчёты может только персонал.', flags: MessageFlags.Ephemeral });
  }
  const data = guildData(interaction.guildId);
  const report = data.reports.find((item) => item.id === reportId);
  if (!report || report.status !== 'pending') {
    return interaction.reply({ content: 'Этот отчёт уже рассмотрен.', flags: MessageFlags.Ephemeral });
  }

  const accepted = decision === 'ok';
  const points = accepted ? Math.max(0, Math.floor(Number(report.points || 0))) : 0;
  report.status = accepted ? 'accepted' : 'rejected';
  report.reviewedAt = Date.now();
  report.reviewerId = interaction.user.id;
  report.points = points;
  if (accepted && points) addBalance(interaction.guildId, report.userId, points);
  else saveSoon();

  await interaction.update({
    components: [buildShopReportReview(report, settings, { reviewed: true })],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  });
  await notifyShopUser(interaction.client, report.userId, accepted ? 'accepted' : 'rejected', {
    typeName: report.typeName,
    imageUrl: report.imageUrl,
    at: report.createdAt,
  });
}

async function handleShopPurchaseReview(interaction) {
  const [, decision, purchaseId] = interaction.customId.split(':');
  const settings = store.getGuild(interaction.guildId);
  if (!canReview(interaction.member, settings)) {
    return interaction.reply({ content: 'Принимать покупки может только персонал.', flags: MessageFlags.Ephemeral });
  }
  const data = guildData(interaction.guildId);
  const purchase = data.purchases.find((item) => item.id === purchaseId);
  if (!purchase || purchase.status !== 'pending') {
    return interaction.reply({ content: 'Эта заявка уже рассмотрена.', flags: MessageFlags.Ephemeral });
  }

  const accepted = decision === 'ok';
  if (accepted && purchase.roleId) {
    const member = await interaction.guild.members.fetch(purchase.userId).catch(() => null);
    const role = interaction.guild.roles.cache.get(purchase.roleId);
    if (!member || !role) {
      return interaction.reply({ content: 'Не удалось выдать роль за товар.', flags: MessageFlags.Ephemeral });
    }
    try {
      await member.roles.add(role, `Покупка в магазине: ${purchase.itemName}`);
    } catch {
      return interaction.reply({
        content: 'Бот не может выдать роль. Проверь права и иерархию.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  purchase.status = accepted ? 'accepted' : 'rejected';
  purchase.reviewedAt = Date.now();
  purchase.reviewerId = interaction.user.id;
  if (!accepted) addBalance(interaction.guildId, purchase.userId, purchase.price);
  else saveSoon();

  await interaction.update({
    components: [buildShopPurchaseReview(purchase, settings, { reviewed: true })],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  });
  await notifyShopUser(interaction.client, purchase.userId, accepted ? 'accepted' : 'rejected', {
    typeName: purchase.itemName,
    at: purchase.createdAt,
  });
}

function setupShop(client) {
  client.once(Events.ClientReady, () => {
    const timer = setInterval(() => {
      for (const guildId of store.getGuildIds()) creditVoicePoints(guildId);
    }, 60_000);
    timer.unref?.();
  });
}

module.exports = {
  getBalance,
  addBalance,
  listBalances,
  shopItems,
  findItem,
  publishShopPanel,
  refreshShopPanels,
  handleShopSelect,
  handleShopButton,
  handleShopReportModal,
  handleShopReview,
  handleShopPurchaseReview,
  setupShop,
};
