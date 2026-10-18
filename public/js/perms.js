// Orate — permission names and descriptions shared by the role editor and the channel / category permission editor.
export const PERM_INFO = {
  ADMINISTRATOR: ['Administrator', 'Grants every permission. Be careful!'], MANAGE_SERVER: ['Manage Server', 'Change the server name, icon and settings.'], MANAGE_CHANNELS: ['Manage Channels', 'Create, edit and delete channels.'],
  MANAGE_ROLES: ['Manage Roles', 'Create and edit roles below their own.'], MANAGE_MESSAGES: ['Manage Messages', 'Delete and pin other people’s messages.'], KICK_MEMBERS: ['Kick Members', 'Remove members (they can rejoin).'],
  BAN_MEMBERS: ['Ban Members', 'Permanently remove members.'], MANAGE_NICKNAMES: ['Manage Nicknames', 'Change other members’ nicknames.'], CREATE_INVITE: ['Create Invite', 'Invite new people.'],
  SEND_MESSAGES: ['Send Messages', 'Post in text channels.'], ATTACH_FILES: ['Attach Files', 'Upload images and files.'], ADD_REACTIONS: ['Add Reactions', 'React to messages.'], MENTION_EVERYONE: ['Mention @everyone', 'Notify the whole server.'],
  CONNECT: ['Connect', 'Join voice channels.'], SPEAK: ['Speak', 'Talk in voice channels.'], CHANGE_NICKNAME: ['Change Nickname', 'Change their own nickname.'],
  VIEW_CHANNEL: ['View Channels', 'See channels and read their messages.'],
};
export const PERM_ORDER = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'VIEW_CHANNEL', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_NICKNAMES', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME'];

/** Inside a channel the same permissions read a little differently. */
export const CHANNEL_PERM_INFO = {
  ...PERM_INFO,
  VIEW_CHANNEL: ['View Channel', 'Lets people see this channel. Turn it off to make it private.'],
  MANAGE_CHANNELS: ['Manage Channel', 'Rename, edit or delete this channel.'],
  MANAGE_ROLES: ['Manage Permissions', 'Change who can see and use this channel.'],
  CREATE_INVITE: ['Create Invite', 'Invite people to the server.'],
  SEND_MESSAGES: ['Send Messages', 'Post in this channel.'],
  MANAGE_MESSAGES: ['Manage Messages', 'Delete and pin other people’s messages here.'],
};
/** The sections of the channel permission editor, per kind of channel. */
export const CHANNEL_PERM_GROUPS = {
  text: [['General', ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE']], ['Text', ['SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES']]],
  voice: [['General', ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE']], ['Voice', ['CONNECT', 'SPEAK']]],
  category: [['General', ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE']], ['Text', ['SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES']], ['Voice', ['CONNECT', 'SPEAK']]],
};
