import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  DMChannel,
  ChannelType,
  BaseGuildTextChannel,
  PermissionFlagsBits,
  Partials,
} from "discord.js";
import { ephemeralFetchConversation } from "./messageFetch";
import { callKindroidAI } from "./kindroidAPI";
import { BotConfig, DMConversationCount } from "./types";

// Track active bot instances
const activeBots = new Map<string, Client>();

// Track DM conversation counts with proper typing
const dmConversationCounts = new Map<string, DMConversationCount>();

// Helper function to check if the bot can respond to a channel before responding
async function canRespondToChannel(
  channel: Message["channel"]
): Promise<boolean> {
  try {
    // For DM channels, we only need to check if we can send messages
    if (channel.type === ChannelType.DM) {
      return true;
    }

    // For all guild-based channels that support messages
    if (channel.isTextBased() && !channel.isDMBased()) {
      const permissions = channel.permissionsFor(channel.client.user);
      if (!permissions) return false;

      // Basic permissions needed for any text-based channel
      const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ];

      // Add thread permissions if the channel is a thread
      if (channel.isThread()) {
        requiredPermissions.push(PermissionFlagsBits.SendMessagesInThreads);
      }

      return permissions.has(requiredPermissions);
    }

    return false;
  } catch (error) {
    console.error("Error checking permissions:", error);
    return false;
  }
}

/**
 * Creates and initializes a Discord client for a specific bot configuration
 * @param botConfig - Configuration for this bot instance
 */
async function createDiscordClientForBot(
  botConfig: BotConfig
): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // Set up event handlers
  client.once("ready", () => {
    console.log(`Bot [${botConfig.id}] logged in as ${client.user?.tag}`);
  });

  // Handle incoming messages
  client.on("messageCreate", async (message: Message) => {
    // Ignore ALL bot messages, including itself and other bots
    if (message.author.bot) {
      return;
    }

    if (!(await canRespondToChannel(message.channel))) return;

    // Handle DMs differently from server messages
    if (message.channel.type === ChannelType.DM) {
      await handleDirectMessage(message, botConfig);
      return;
    }

    // Get the bot's user information
    const botUser = client.user;
    if (!botUser) return;

    // Only respond if directly mentioned
    const isMentioned = message.mentions.users.has(botUser.id);

    // Ignore if the bot is not mentioned
    if (!isMentioned) return;

    try {
      // Show typing indicator
      if (
        message.channel instanceof BaseGuildTextChannel ||
        message.channel instanceof DMChannel
      ) {
        await message.channel.sendTyping();
      }

      // Fetch recent conversation with caching
      const conversationArray = await ephemeralFetchConversation(
        message.channel as TextChannel | DMChannel,
        4, // last 30 messages
        5000 // 5 second cache
      );

      // Call Kindroid AI with the conversation context
      const aiResult = await callKindroidAI(
        botConfig.sharedAiCode,
        conversationArray,
        botConfig.enableFilter
      );

      // If rate limited, silently ignore
      if (aiResult.type === "rate_limited") {
        return;
      }

      // Reply directly to the triggering message
      await message.reply(aiResult.reply);
    } catch (error) {
      console.error(`[Bot ${botConfig.id}] Error:`, error);
      await message.reply(
        "Beep boop, something went wrong. Please contact the Kindroid owner if this keeps up!"
      );
    }
  });

  // Handle errors
  client.on("error", (error: Error) => {
    console.error(`[Bot ${botConfig.id}] WebSocket error:`, error);
  });

  // Login
  try {
    await client.login(botConfig.discordBotToken);
    activeBots.set(botConfig.id, client);
  } catch (error) {
    console.error(`Failed to login bot ${botConfig.id}:`, error);
    throw error;
  }

  return client;
}

/**
 * Handle direct messages to the bot
 * @param message - The Discord message
 * @param botConfig - The bot's configuration
 */
async function handleDirectMessage(
  message: Message,
  botConfig: BotConfig
): Promise<void> {
  const userId = message.author.id;
  const dmKey = `${botConfig.id}-${userId}`;

  // Initialize or increment DM count
  const currentData = dmConversationCounts.get(dmKey) || {
    count: 0,
    lastMessageTime: 0,
  };

  const newCount = currentData.count + 1;
  dmConversationCounts.set(dmKey, {
    count: newCount,
    lastMessageTime: Date.now(),
  });

  try {
    // Show typing indicator
    if (message.channel instanceof DMChannel) {
      await message.channel.sendTyping();

      // Fetch recent conversation
      const conversationArray = await ephemeralFetchConversation(
        message.channel,
        4,
        5000
      );

      // Call Kindroid AI
      const aiResult = await callKindroidAI(
        botConfig.sharedAiCode,
        conversationArray,
        botConfig.enableFilter
      );

      // If rate limited, silently ignore
      if (aiResult.type === "rate_limited") {
        return;
      }

      // Send the AI's reply
      await message.reply(aiResult.reply);
    }
  } catch (error) {
    console.error(`[Bot ${botConfig.id}] DM Error:`, error);
    await message.reply(
      "Beep boop, something went wrong. Please contact the Kindroid owner if this keeps up!"
    );
  }
}

/**
 * Initialize all bots from their configurations
 * @param botConfigs - Array of bot configurations
 */
async function initializeAllBots(botConfigs: BotConfig[]): Promise<Client[]> {
  console.log(`Initializing ${botConfigs.length} bots...`);

  const initPromises = botConfigs.map((config) =>
    createDiscordClientForBot(config).catch((error) => {
      console.error(`Failed to initialize bot ${config.id}:`, error);
      return null;
    })
  );

  const results = await Promise.all(initPromises);
  const successfulBots = results.filter(
    (client): client is Client => client !== null
  );

  console.log(
    `Successfully initialized ${successfulBots.length} out of ${botConfigs.length} bots`
  );

  return successfulBots;
}

/**
 * Gracefully shutdown all active bots
 */
async function shutdownAllBots(): Promise<void> {
  console.log("Shutting down all bots...");

  const shutdownPromises = Array.from(activeBots.entries()).map(
    async ([id, client]) => {
      try {
        await client.destroy();
        console.log(`Bot ${id} shutdown successfully`);
      } catch (error) {
        console.error(`Error shutting down bot ${id}:`, error);
      }
    }
  );

  await Promise.all(shutdownPromises);
  activeBots.clear();
  dmConversationCounts.clear();
}

export { initializeAllBots, shutdownAllBots };
