// Single source of truth for the bot's PUBLIC command menu (setMyCommands).
// The handler parses incoming text directly (text.startsWith('/ask') etc.);
// this list is specifically the menu/autocomplete registration. Keep the two
// conceptually in sync: every command a user should DISCOVER belongs here.
// (/whoami is public; @mention is not a slash command, so it is not listed.)

export interface BotCommand {
  command: string;      // without the leading slash
  description: string;  // shown in the / menu (Telegram limit ~256 chars; keep short)
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: 'context', description: 'See what docs the bot answers from here' },
  { command: 'recap',   description: 'Summarize the last messages in this topic' },
  { command: 'whoami',  description: "Show this chat's ids (setup/diagnostics)" },
  { command: 'auth',    description: 'Link this Telegram group to a workspace' },
  { command: 'push',    description: 'Save this reply as lasting context (admins)' },
  { command: 'help',    description: 'Show what the bot can do' },
];
