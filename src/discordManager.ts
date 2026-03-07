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

// Optional duplicate-event protection
const processedMessages = new Map<string, number>();
const MESSAGE_TTL_MS = 60_000;

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
    // Ignore ALL bot messages, including itself and other bots/webhooks
    if (message.author.bot) return;

    // Deduplicate repeated Discord events for a short time window
    const now = Date.now();

    for (const [id, ts] of processedMessages.entries()) {
      if (now - ts > MESSAGE_TTL_MS) {
        processedMessages.delete(id);
      }
    }

    if (processedMessages
