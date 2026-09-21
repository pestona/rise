const {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const store = require('./store');
const { buildAutoparkPanel } = require('./ui');

function panelPayload(settings) {
  return {
    ...buildAutoparkPanel(settings),
    allowedMentions: { parse: [] },
  };
}

async function refreshAutoparkPanels(client, guildId) {
  const settings = store.getGuild(guildId);
  const dead = [];

  for (const entry of store.listPanels(guildId).filter((item) => item.key === 'autopark')) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      if (message.flags.has(MessageFlags.IsComponentsV2)) {
        const replacement = await channel.send(panelPayload(settings));
        store.rememberPanel(guildId, {
          key: 'autopark',
          channelId: channel.id,
          messageId: replacement.id,
        });
        await message.delete().catch(() => null);
        dead.push(entry.messageId);
      } else {
        await message.edit(panelPayload(settings));
      }
    } catch (error) {
      if (error.code === 10008) dead.push(entry.messageId);
      else console.warn('Не удалось обновить панель автопарка:', error.message);
    }
  }

  if (dead.length) {
    store.setPanels(
      guildId,
      store.listPanels(guildId).filter((item) => !dead.includes(item.messageId)),
    );
  }
}

async function publishAutoparkPanel(interaction, channel) {
  const settings = store.getGuild(interaction.guildId);
  const existing = store
    .listPanels(interaction.guildId)
    .find((item) => item.key === 'autopark' && item.channelId === channel.id);

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      if (message.flags.has(MessageFlags.IsComponentsV2)) {
        const replacement = await channel.send(panelPayload(settings));
        await message.delete().catch(() => null);
        store.setPanels(
          interaction.guildId,
          store
            .listPanels(interaction.guildId)
            .filter((item) => item.messageId !== existing.messageId),
        );
        store.rememberPanel(interaction.guildId, {
          key: 'autopark',
          channelId: channel.id,
          messageId: replacement.id,
        });
        return { edited: false, message: replacement };
      }
      await message.edit(panelPayload(settings));
      return { edited: true, message };
    } catch {
      // Сообщение удалено — создадим новое.
    }
  }

  const message = await channel.send(panelPayload(settings));
  store.rememberPanel(interaction.guildId, {
    key: 'autopark',
    channelId: channel.id,
    messageId: message.id,
  });
  return { edited: false, message };
}

async function handleVehicleSelect(interaction) {
  const vehicleId = interaction.values[0];
  const action = interaction.customId.split(':')[2];
  const settings = store.getGuild(interaction.guildId);
  const vehicle = settings.autopark?.vehicles?.find((item) => item.id === vehicleId);

  if (!vehicle) {
    await interaction.reply({
      content: 'Машина не найдена.',
      flags: MessageFlags.Ephemeral,
    });
    await refreshAutoparkPanels(interaction.client, interaction.guildId);
    return;
  }
  if (action === 'take') {
    const roleIds = vehicle.roleIds || [];
    if (roleIds.length && !roleIds.some((id) => interaction.member.roles.cache.has(id))) {
      return interaction.reply({
        content: `Для этой машины нужна одна из ролей: ${roleIds.map((id) => `<@&${id}>`).join(' ')}.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    const alreadyTaken = settings.autopark.vehicles.find(
      (car) => car.inUseById === interaction.user.id,
    );
    if (alreadyTaken) {
      return interaction.reply({
        content:
          `У вас уже есть машина **${alreadyTaken.name}** · \`${alreadyTaken.plate}\`. ` +
          'Сначала освободите её.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (vehicle.inUseById) {
      return interaction.reply({
        content: `Машина уже занята пользователем <@${vehicle.inUseById}>.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }

    const now = Date.now();
    store.updateGuild(interaction.guildId, (guild) => {
      const car = guild.autopark.vehicles.find((item) => item.id === vehicleId);
      car.inUseById = interaction.user.id;
      car.takenAt = now;
      car.returnAt = now + (guild.autopark.durationMinutes || 60) * 60 * 1000;
    });
    await interaction.update({
      content: `Вы заняли **${vehicle.name}** · \`${vehicle.plate}\`.`,
      components: [],
    });
  } else {
    if (!vehicle.inUseById) {
      return interaction.reply({
        content: 'Эта машина уже свободна.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (vehicle.inUseById !== interaction.user.id) {
      return interaction.reply({
        content: 'Освободить машину может только тот, кто её занял.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      const car = guild.autopark.vehicles.find((item) => item.id === vehicleId);
      car.inUseById = null;
      car.takenAt = null;
      car.returnAt = null;
    });
    await interaction.update({
      content: `Вы освободили **${vehicle.name}** · \`${vehicle.plate}\`.`,
      components: [],
    });
  }

  await refreshAutoparkPanels(interaction.client, interaction.guildId);
}

async function handleVehicleAction(interaction) {
  const action = interaction.customId.split(':')[1];
  const settings = store.getGuild(interaction.guildId);
  const vehicles = settings.autopark?.vehicles || [];
  const userVehicle = vehicles.find((car) => car.inUseById === interaction.user.id);

  if (action === 'return') {
    if (!userVehicle) {
      return interaction.reply({
        content: 'У вас нет занятой машины.',
        flags: MessageFlags.Ephemeral,
      });
    }
    store.updateGuild(interaction.guildId, (guild) => {
      const car = guild.autopark.vehicles.find((item) => item.id === userVehicle.id);
      car.inUseById = null;
      car.takenAt = null;
      car.returnAt = null;
    });
    await interaction.reply({
      content: `Вы освободили **${userVehicle.name}** · \`${userVehicle.plate}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    await refreshAutoparkPanels(interaction.client, interaction.guildId);
    return;
  }

  if (userVehicle) {
    return interaction.reply({
      content:
        `У вас уже занята **${userVehicle.name}** · \`${userVehicle.plate}\`. ` +
        'Сначала освободите её.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const available = vehicles.filter((car) => !car.inUseById);
  if (!available.length) {
    return interaction.reply({
      content: 'Свободных машин сейчас нет.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('car:choose:take')
    .setPlaceholder('Какую машину занять?')
    .addOptions(
      available.slice(0, 25).map((car) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(car.name.slice(0, 100))
          .setDescription(car.plate.slice(0, 100))
          .setValue(car.id),
      ),
    );

  return interaction.reply({
    content: 'Выберите свободную машину:',
    components: [new ActionRowBuilder().setComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function releaseExpiredVehicles(client) {
  for (const guildId of store.getGuildIds()) {
    const settings = store.getGuild(guildId);
    const expired = (settings.autopark?.vehicles || []).filter(
      (car) => car.inUseById && car.returnAt && car.returnAt <= Date.now(),
    );
    if (!expired.length) continue;

    store.updateGuild(guildId, (guild) => {
      for (const car of guild.autopark.vehicles) {
        if (car.inUseById && car.returnAt && car.returnAt <= Date.now()) {
          car.inUseById = null;
          car.takenAt = null;
          car.returnAt = null;
        }
      }
    });
    await refreshAutoparkPanels(client, guildId);
  }
}

function setupAutoparkTimers(client) {
  client.once('ready', () => {
    releaseExpiredVehicles(client).catch(console.error);
    for (const guildId of store.getGuildIds()) {
      refreshAutoparkPanels(client, guildId).catch(console.error);
    }
    setInterval(() => releaseExpiredVehicles(client).catch(console.error), 1_000);
  });
}

module.exports = {
  refreshAutoparkPanels,
  publishAutoparkPanel,
  handleVehicleSelect,
  handleVehicleAction,
  setupAutoparkTimers,
};
