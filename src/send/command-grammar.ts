// `team send`'s and `team reply`'s option grammar, in one module of its own: the commands parse
// with it, and the confined-seat relay (src/send/confined-outbox.ts) reads a relayed line with
// exactly the same words, without importing either command.

/** `team send`: the names that take a value, and the flags. */
export const SEND_VALUED_OPTIONS = ['file', 'brief', 'timeout', 'record', 'channel', 'ms', 'confirm', 'client', 'key', 'request-id', 'subject', 'approval', 'reason'] as const;
export const SEND_FLAG_OPTIONS = ['wait', 'json', 'list', 'dry-run', 'request'] as const;

/** `team reply` takes no valued option; these are its flags. */
export const REPLY_FLAG_OPTIONS = ['close', 'json'] as const;

/** `team ack <id>`: no valued option; one flag. Its scoped form (`--seat`, `--older-than`) is read
 *  by its own parser in src/commands/ack.ts and is never relayed. */
export const ACK_FLAG_OPTIONS = ['json'] as const;

/** `team drops`: the names that take a value, and the flags. */
export const DROPS_VALUED_OPTIONS = ['seat', 'session', 'epoch', 'id'] as const;
export const DROPS_FLAG_OPTIONS = ['follow', 'json', 'read', 'dry-run', 'unread'] as const;
