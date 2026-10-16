const { ChannelType } = require('discord.js');
const store = require('./store');
const { buildCustomPanel, v2Flags } = require('./ui');

function customPanelKey(id) {
  return `custom:${id}`;
}

function panelPayload(panel) {
  return {
    components: [buildCustomPanel(panel)],
    flags: v2Flags(false),
    allowedMentions: { parse: [] },
  };
}

function findCustomPanel(guild, panelId) {
  return (guild.customPanels?.items || []).find((item) => item.id === panelId) || null;
}

async function refreshCustomPanels(client, guildId, panelId = null) {
  const settings = store.getGuild(guildId);
  const items = settings.customPanels?.items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => String(item.key || '').startsWith('custom:'))) {
    const id = String(entry.key).slice('custom:'.length);
    if (panelId && id !== panelId) continue;
    const panel = byId.get(id);
    if (!panel) {
      dead.push(entry.messageId);
      continue;
    }
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(panelPayload(panel));
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить custom-panel:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function publishCustomPanel(interaction, channel, panel) {
  if (!panel) throw new Error('no-panel');
  const payload = panelPayload(panel);
  const key = customPanelKey(panel.id);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === key && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      store.rememberPanel(interaction.guildId, {
        key,
        channelId: channel.id,
        messageId: message.id,
      });
      return { edited: true, message };
    } catch {
      // старое сообщение удалили — отправим новое
    }
  }

  if (channel.type === ChannelType.GuildForum) {
    throw new Error('forum');
  }

  const message = await channel.send(payload);
  store.rememberPanel(interaction.guildId, {
    key,
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function unpublishCustomPanel(client, guildId, panelId) {
  const key = customPanelKey(panelId);
  const entries = store.listPanels(guildId).filter((item) => item.key === key);
  for (const entry of entries) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.delete();
    } catch {
      // сообщение уже нет
    }
  }
  store.setPanels(
    guildId,
    store.listPanels(guildId).filter((item) => item.key !== key),
  );
}

module.exports = {
  customPanelKey,
  findCustomPanel,
  publishCustomPanel,
  refreshCustomPanels,
  unpublishCustomPanel,
};
