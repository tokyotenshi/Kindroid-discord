import { TextChannel, DMChannel, Message } from "discord.js";
import { ConversationMessage } from "./types";

// Track message cache with proper typing
interface CacheEntry {
  lastFetchTime: number;
  messages: ConversationMessage[];
}

// Cache for display names
interface DisplayNameCacheEntry {
  displayName: string;
  lastFetchTime: number;
}

// In-memory cache for recent message fetches
const channelCache = new Map<string, CacheEntry>();
// Cache for display names - key is guildId:userId
const displayNameCache = new Map<string, DisplayNameCacheEntry>();

const DISPLAY_NAME_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Gets the display name for a message author with proper member fetching
 * @param msg - Discord message
 * @returns The most appropriate display name
 */
async function getUserDisplayName(msg: Message): Promise<string> {
  try {
    // Check cache first
    const cacheKey = msg.guildId
      ? `${msg.guildId}:${msg.author.id}`
      : msg.author.id;
    const now = Date.now();
    const cached = displayNameCache.get(cacheKey);

    if (cached && now - cached.lastFetchTime < DISPLAY_NAME_CACHE_DURATION) {
      return cached.displayName;
    }

    let displayName: string;

    // If in a guild, try to get server nickname
    if (msg.guildId) {
      try {
        const guild = msg.client.guilds.cache.get(msg.guildId);
        if (!guild) {
          throw new Error("Guild not found in cache");
        }

        const member = await guild.members.fetch(msg.author.id);
        if (member && member.nickname) {
          displayName = member.nickname;
        } else if (msg.author.globalName) {
          displayName = msg.author.globalName;
        } else {
          displayName = msg.author.username;
        }
      } catch (error) {
        console.error("Error fetching guild member:", error);
        displayName = msg.author.globalName || msg.author.username;
      }
    } else {
      displayName = msg.author.globalName || msg.author.username;
    }

    // Update cache
    displayNameCache.set(cacheKey, {
      displayName,
      lastFetchTime: now,
    });

    // Clean old cache entries periodically
    if (displayNameCache.size > 1000) {
      const oldestAllowed = now - DISPLAY_NAME_CACHE_DURATION;
      for (const [key, value] of displayNameCache.entries()) {
        if (value.lastFetchTime < oldestAllowed) {
          displayNameCache.delete(key);
        }
      }
    }

    return displayName;
  } catch (error) {
    console.error("Error getting display name:", error);
    return msg.author.username;
  }
}

/**
 * Fetches conversation from Discord channel
 * @param channel - The Discord channel to fetch from
 * @param limit - Number of messages to fetch
 * @returns Array of formatted messages
 */
async function fetchConversationFromDiscord(
  channel: TextChannel | DMChannel,
  limit: number = 30
): Promise<ConversationMessage[]> {
  try {
    // Fetch messages from Discord
    const fetched = await channel.messages.fetch({ limit });

    // Sort messages chronologically (oldest first)
    const sorted = Array.from(fetched.values()).sort(
      (a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp
    );

    // Get our bot's client ID
    const ourBotId = channel.client.user?.id;
    if (!ourBotId) {
      throw new Error("Bot client ID not found");
    }

    // Keep only HUMAN messages
    const humanMessages = sorted.filter((msg) => msg.author.id !== ourBotId);

    // Pre-fetch display names for all humans
    const uniqueUsers = new Set(humanMessages.map((msg) => msg.author.id));
    const displayNamePromises = Array.from(uniqueUsers).map(async (userId) => {
      const userMsg = humanMessages.find((m) => m.author.id === userId);
      if (userMsg) {
        await getUserDisplayName(userMsg);
      }
    });

    await Promise.all(displayNamePromises);

    // Format only human messages
    const messages = await Promise.all(
      humanMessages.map(
        async (msg: Message): Promise<ConversationMessage> => ({
          username: await getUserDisplayName(msg),
          text: msg.content,
          timestamp: msg.createdAt.toISOString(),
        })
      )
    );

    return messages;
  } catch (error) {
    console.error("Error fetching messages:", error);
    throw new Error("Failed to fetch conversation history");
  }
}

/**
 * Fetches conversation with caching support
 * @param channel - The Discord channel
 * @param limit - Number of messages to fetch
 * @param cacheDurationMs - How long to cache messages
 */
async function ephemeralFetchConversation(
  channel: TextChannel | DMChannel,
  limit: number = 30,
  cacheDurationMs: number = 5000
): Promise<ConversationMessage[]> {
  const now = Date.now();
  const cacheKey = channel.id;
  const cached = channelCache.get(cacheKey);

  // Return cached data if it's fresh
  if (cached && now - cached.lastFetchTime < cacheDurationMs) {
    return cached.messages;
  }

  // Fetch new data
  const messages = await fetchConversationFromDiscord(channel, limit);

  // Update cache
  channelCache.set(cacheKey, {
    lastFetchTime: now,
    messages,
  });

  // Clean old cache entries periodically
  if (channelCache.size > 1000) {
    const oldestAllowed = now - cacheDurationMs;
    for (const [key, value] of channelCache.entries()) {
      if (value.lastFetchTime < oldestAllowed) {
        channelCache.delete(key);
      }
    }
  }

  return messages;
}

export { fetchConversationFromDiscord, ephemeralFetchConversation };
