const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const APPS_FILE = path.join(DATA_DIR, 'applications.json');
const BACKUPS_FILE = path.join(DATA_DIR, 'backups.json');

const DEFAULT_QUESTIONS = {
  vzp: [
    { label: 'Ваш игровой ник', style: 'short', required: true, maxLength: 80 },
    { label: 'Ваш статик (ID)', style: 'short', required: true, maxLength: 40 },
    { label: 'Ваш возраст', style: 'short', required: true, maxLength: 10 },
    { label: 'Сколько лет в GTA RP', style: 'short', required: true, maxLength: 40 },
    { label: 'Почему хотите вступить в VZP', style: 'paragraph', required: true, maxLength: 800 },
  ],
  rp: [
    { label: 'Ваш игровой ник', style: 'short', required: true, maxLength: 80 },
    { label: 'Ваш статик (ID)', style: 'short', required: true, maxLength: 40 },
    { label: 'Ваш возраст', style: 'short', required: true, maxLength: 10 },
    { label: 'Опыт RP (кратко)', style: 'paragraph', required: true, maxLength: 800 },
    { label: 'Почему хотите в семью', style: 'paragraph', required: true, maxLength: 800 },
  ],
};

function defaultType(key) {
  return {
    enabled: false,
    label: key.toUpperCase(),
    reviewChannelId: null,
    acceptedChannelId: null,
    resultForumId: null,
    logChannelId: null,
    roleId: null,
    questions: DEFAULT_QUESTIONS[key].map((q) => ({ ...q })),
  };
}

function defaultGuild() {
  return {
    bannerUrl: '',
    accentColor: 0x111111,
    panelTitle: 'Оформление заявки в семью.',
    panelDescription:
      'После подачи заявка отправляется на рассмотрение персоналу.\n\n' +
      '> В среднем заявки обрабатываются в течение 1–2 дней\n\n' +
      'Следите за статусом набора.\n' +
      '**Если возможности заполнить заявку нет — набор закрыт.**\n' +
      'Каждое открытие набора сопровождается тегами в этом канале.\n\n' +
      '> В случае отказа можете подать заявку повторно через {cooldown} дн.',
    cooldownDays: 7,
    staffRoleIds: [],
    logs: {
      leaveChannelId: null,
      moderationChannelId: null,
      watchedRoleIds: [],
    },
    autopark: {
      vehicles: [],
      selectedVehicleId: null,
      durationMinutes: 60,
    },
    positions: {
      imageUrl: '',
      slotCount: 10,
      claims: {},
    },
    gatherings: {
      listChannelId: null,
      statsChannelId: null,
      threadRoleIds: [],
      selectedPresetId: 'mp',
      presets: [
        { id: 'family', name: 'Семейный сбор', description: 'Общий сбор семьи' },
        { id: 'mp', name: 'МП', description: 'Список на мероприятие' },
        { id: 'contract', name: 'Контракт', description: 'Сбор на контракт' },
        { id: 'train', name: 'Тренировка', description: 'Тренировочный сбор' },
      ],
      active: null,
    },
    security: {
      enabled: false,
      logChannelId: null,
      trustedUserIds: [],
      trustedRoleIds: [],
      managerUserIds: [],
      actionLimit: 3,
      windowSeconds: 10,
      lastBackupAt: null,
    },
    access: {
      selectedAction: 'gatheringCreate',
      roles: {
        gatheringCreate: [],
        positionsCreate: [],
        applicationReview: [],
        gatheringModerate: [],
        positionModerate: [],
        panelsPublish: [],
        settingsManage: [],
      },
    },
    panel: { channelId: null, messageId: null },
    adminPanel: { channelId: null, messageId: null },
    publishPanelKey: 'tickets',
    panels: [],
    types: {
      vzp: defaultType('vzp'),
      rp: defaultType('rp'),
    },
  };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizeStore() {
  if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) {
    db.settings = { guilds: {} };
  }
  if (!db.settings.guilds || typeof db.settings.guilds !== 'object' || Array.isArray(db.settings.guilds)) {
    db.settings.guilds = {};
  }
  if (!db.applications || typeof db.applications !== 'object' || Array.isArray(db.applications)) {
    db.applications = { items: [] };
  }
  if (!Array.isArray(db.applications.items)) {
    db.applications.items = [];
  }
  if (!db.backups || typeof db.backups !== 'object' || Array.isArray(db.backups)) {
    db.backups = { guilds: {} };
  }
  if (!db.backups.guilds || typeof db.backups.guilds !== 'object' || Array.isArray(db.backups.guilds)) {
    db.backups.guilds = {};
  }
}

const db = {
  settings: loadJson(SETTINGS_FILE, { guilds: {} }),
  applications: loadJson(APPS_FILE, { items: [] }),
  backups: loadJson(BACKUPS_FILE, { guilds: {} }),
};

normalizeStore();

function persistSettings() {
  normalizeStore();
  saveJson(SETTINGS_FILE, db.settings);
}

function persistApps() {
  normalizeStore();
  saveJson(APPS_FILE, db.applications);
}

function persistBackups() {
  normalizeStore();
  saveJson(BACKUPS_FILE, db.backups);
}

function getGuild(guildId) {
  normalizeStore();
  if (!db.settings.guilds[guildId]) {
    db.settings.guilds[guildId] = defaultGuild();
    persistSettings();
  } else {
    db.settings.guilds[guildId] = deepMerge(defaultGuild(), db.settings.guilds[guildId]);
    let dirty = false;
    const oldDescription = db.settings.guilds[guildId].panelDescription;
    db.settings.guilds[guildId].panelDescription = String(
      db.settings.guilds[guildId].panelDescription || '',
    ).replace(
      'Уведомление о приглашении отправляется в личные сообщения.',
      'После подачи заявка отправляется на рассмотрение персоналу.',
    );
    if (oldDescription !== db.settings.guilds[guildId].panelDescription) dirty = true;
    if (!db.settings.guilds[guildId].types?.vzp || !db.settings.guilds[guildId].types?.rp) {
      db.settings.guilds[guildId].types = defaultGuild().types;
    }
    if (!Array.isArray(db.settings.guilds[guildId].types.vzp.questions)) {
      db.settings.guilds[guildId].types.vzp.questions = defaultType('vzp').questions;
    }
    if (!Array.isArray(db.settings.guilds[guildId].types.rp.questions)) {
      db.settings.guilds[guildId].types.rp.questions = defaultType('rp').questions;
    }
    if (!Array.isArray(db.settings.guilds[guildId].panels)) {
      db.settings.guilds[guildId].panels = [];
      dirty = true;
    }
    if (Object.hasOwn(db.settings.guilds[guildId], 'staffRoleId')) {
      const oldRoleId = db.settings.guilds[guildId].staffRoleId;
      if (oldRoleId && !db.settings.guilds[guildId].staffRoleIds.includes(oldRoleId)) {
        db.settings.guilds[guildId].staffRoleIds.push(oldRoleId);
      }
      delete db.settings.guilds[guildId].staffRoleId;
      dirty = true;
    }
    if (Object.hasOwn(db.settings.guilds[guildId], 'ticketLogChannelId')) {
      const oldLogChannelId = db.settings.guilds[guildId].ticketLogChannelId;
      for (const type of Object.values(db.settings.guilds[guildId].types)) {
        if (!type.logChannelId) type.logChannelId = oldLogChannelId;
      }
      delete db.settings.guilds[guildId].ticketLogChannelId;
      dirty = true;
    }
    for (const vehicle of db.settings.guilds[guildId].autopark?.vehicles || []) {
      if (!Array.isArray(vehicle.roleIds)) {
        vehicle.roleIds = vehicle.roleId ? [vehicle.roleId] : [];
        dirty = true;
      }
      if (Object.hasOwn(vehicle, 'durationMinutes')) {
        delete vehicle.durationMinutes;
        dirty = true;
      }
      if (vehicle.inUseById && !vehicle.returnAt) {
        vehicle.returnAt =
          (vehicle.takenAt || Date.now()) +
          db.settings.guilds[guildId].autopark.durationMinutes * 60 * 1000;
        dirty = true;
      }
    }
    const panel = db.settings.guilds[guildId].panel;
    if (panel?.channelId && panel?.messageId) {
      const exists = db.settings.guilds[guildId].panels.some((item) => item.messageId === panel.messageId);
      if (!exists) {
        db.settings.guilds[guildId].panels.push({
          key: 'tickets',
          channelId: panel.channelId,
          messageId: panel.messageId,
        });
        dirty = true;
      }
    }
    if (!Array.isArray(db.settings.guilds[guildId].security?.managerUserIds)) {
      if (!db.settings.guilds[guildId].security) {
        db.settings.guilds[guildId].security = defaultGuild().security;
      } else {
        db.settings.guilds[guildId].security.managerUserIds = [];
      }
      dirty = true;
    }
    const access = db.settings.guilds[guildId].access;
    for (const key of Object.keys(defaultGuild().access.roles)) {
      if (!Array.isArray(access.roles[key])) {
        access.roles[key] = [];
        dirty = true;
      }
    }
    if (!Object.hasOwn(access.roles, access.selectedAction)) {
      access.selectedAction = 'gatheringCreate';
      dirty = true;
    }
    if (!db.settings.guilds[guildId].gatherings) {
      db.settings.guilds[guildId].gatherings = defaultGuild().gatherings;
      dirty = true;
    } else {
      const gatherings = db.settings.guilds[guildId].gatherings;
      if (Object.hasOwn(gatherings, 'pingRoleId')) {
        delete gatherings.pingRoleId;
        dirty = true;
      }
      if (!Array.isArray(gatherings.threadRoleIds)) {
        gatherings.threadRoleIds = [];
        dirty = true;
      }
      if (!Array.isArray(gatherings.presets) || !gatherings.presets.length) {
        gatherings.presets = defaultGuild().gatherings.presets;
        dirty = true;
      }
      if (gatherings.active) {
        if (!Array.isArray(gatherings.active.pingRoleIds)) {
          gatherings.active.pingRoleIds = gatherings.active.pingRoleId
            ? [gatherings.active.pingRoleId]
            : [];
          dirty = true;
        }
        if (Object.hasOwn(gatherings.active, 'pingRoleId')) {
          delete gatherings.active.pingRoleId;
          dirty = true;
        }
        if (typeof gatherings.active.pingEveryone !== 'boolean') {
          gatherings.active.pingEveryone = false;
          dirty = true;
        }
        if (!Array.isArray(gatherings.active.main)) {
          gatherings.active.main = [];
          dirty = true;
        }
        if (!Array.isArray(gatherings.active.bench)) {
          gatherings.active.bench = [];
          dirty = true;
        }
        if (typeof gatherings.active.closed !== 'boolean') {
          gatherings.active.closed = false;
          dirty = true;
        }
      }
    }
    if (['gatherings', 'positions'].includes(db.settings.guilds[guildId].publishPanelKey)) {
      db.settings.guilds[guildId].publishPanelKey = 'tickets';
      dirty = true;
    }
    if (dirty) persistSettings();
  }
  return db.settings.guilds[guildId];
}

function updateGuild(guildId, mutator) {
  const guild = getGuild(guildId);
  mutator(guild);
  persistSettings();
  return guild;
}

function getType(guildId, type) {
  return getGuild(guildId).types[type];
}

function allApps() {
  return db.applications.items;
}

function addApp(app) {
  db.applications.items.push(app);
  persistApps();
  return app;
}

function findApp(id) {
  return db.applications.items.find((a) => a.id === id) || null;
}

function updateApp(id, patch) {
  const app = findApp(id);
  if (!app) return null;
  Object.assign(app, patch);
  persistApps();
  return app;
}

function pendingApp(guildId, userId, type) {
  return db.applications.items.find(
    (a) =>
      a.guildId === guildId &&
      a.userId === userId &&
      a.type === type &&
      ['pending', 'interview'].includes(a.status),
  );
}

function lastRejected(guildId, userId, type) {
  const list = db.applications.items
    .filter((a) => a.guildId === guildId && a.userId === userId && a.type === type && a.status === 'rejected')
    .sort((a, b) => (b.reviewedAt || 0) - (a.reviewedAt || 0));
  return list[0] || null;
}

function nextNumber(guildId) {
  const count = db.applications.items.filter((a) => a.guildId === guildId).length;
  return count + 1;
}

function rememberPanel(guildId, entry) {
  if (!entry?.channelId || !entry?.messageId) return getGuild(guildId);
  return updateGuild(guildId, (guild) => {
    if (!Array.isArray(guild.panels)) guild.panels = [];
    guild.panels = guild.panels.filter((item) => item.messageId !== entry.messageId);
    guild.panels.push({
      key: entry.key || 'tickets',
      channelId: entry.channelId,
      messageId: entry.messageId,
    });
    guild.panel = { channelId: entry.channelId, messageId: entry.messageId };
  });
}

function setPanels(guildId, panels) {
  return updateGuild(guildId, (guild) => {
    guild.panels = panels;
    const last = panels[panels.length - 1];
    guild.panel = last
      ? { channelId: last.channelId, messageId: last.messageId }
      : { channelId: null, messageId: null };
  });
}

function listPanels(guildId) {
  return [...(getGuild(guildId).panels || [])];
}

function getGuildIds() {
  normalizeStore();
  return Object.keys(db.settings.guilds);
}

function getBackup(guildId) {
  normalizeStore();
  return db.backups.guilds[guildId] || null;
}

function setBackup(guildId, backup) {
  normalizeStore();
  db.backups.guilds[guildId] = backup;
  persistBackups();
  return backup;
}

module.exports = {
  DEFAULT_QUESTIONS,
  getGuild,
  updateGuild,
  getType,
  addApp,
  findApp,
  updateApp,
  pendingApp,
  lastRejected,
  nextNumber,
  allApps,
  rememberPanel,
  setPanels,
  listPanels,
  getGuildIds,
  getBackup,
  setBackup,
};
