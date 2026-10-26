// JSON Schemas (draft 2020-12) for every normalized/ file and reconciliation.json. They are written
// into each export (normalized/schemas/) so the export validates on its own, without this tool (AC-15).

type Schema = Record<string, unknown>;

const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const hex = { type: 'string', pattern: '^(0x[0-9a-f]*)?$' };
const iso = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' };
const castId = { type: 'object', additionalProperties: false, required: ['fid', 'hash'], properties: { fid: int, hash: hex } };
const embed = { oneOf: [{ type: 'object', additionalProperties: false, required: ['url'], properties: { url: str } }, { type: 'object', additionalProperties: false, required: ['castId'], properties: { castId } }] };
const sourceProtocol = { const: 'protocol' };

const obj = (required: string[], properties: Record<string, unknown>): Schema => ({ type: 'object', additionalProperties: false, required, properties });

function fileSchema(dataset: string, record: Schema): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://fcx.local/schemas/v1/${dataset}.schema.json`,
    title: `fcx normalized ${dataset} (schemaVersion 1)`,
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'dataset', 'fid', 'records'],
    properties: { schemaVersion: { const: 1 }, dataset: { const: dataset }, fid: int, records: { type: 'array', items: { $ref: '#/$defs/record' } } },
    $defs: { record },
  };
}

const graph = obj(['fid', 'inProtocol', 'inClientList', 'source'], {
  fid: int,
  username: str,
  displayName: str,
  since: iso,
  protocolHash: hex,
  inProtocol: bool,
  inClientList: bool,
  selfFollow: bool,
  source: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['protocol', 'client'] } },
});

export const SCHEMAS: Record<string, Schema> = {
  casts: fileSchema(
    'casts',
    obj(['hash', 'fid', 'kind', 'timestamp', 'source', 'protocolHash'], {
      hash: hex,
      fid: int,
      kind: { enum: ['add', 'remove'] },
      timestamp: iso,
      text: str,
      castType: int,
      mentions: { type: 'array', items: int },
      mentionsPositions: { type: 'array', items: int },
      embeds: { type: 'array', items: embed },
      parentCastId: castId,
      parentUrl: str,
      targetHash: hex,
      source: sourceProtocol,
      protocolHash: hex,
    }),
  ),
  reactions: fileSchema(
    'reactions',
    obj(['hash', 'fid', 'kind', 'reactionType', 'timestamp', 'source', 'protocolHash'], {
      hash: hex,
      fid: int,
      kind: { enum: ['add', 'remove'] },
      reactionType: { enum: ['like', 'recast', 'other'] },
      targetCastId: castId,
      targetUrl: str,
      timestamp: iso,
      source: sourceProtocol,
      protocolHash: hex,
    }),
  ),
  links: fileSchema(
    'links',
    obj(['hash', 'fid', 'kind', 'linkType', 'timestamp', 'source', 'protocolHash'], {
      hash: hex,
      fid: int,
      kind: { enum: ['add', 'remove', 'compact_state'] },
      linkType: str,
      targetFid: int,
      targetFids: { type: 'array', items: int },
      displayTimestamp: iso,
      timestamp: iso,
      source: sourceProtocol,
      protocolHash: hex,
    }),
  ),
  following: fileSchema('following', graph),
  followers: fileSchema('followers', graph),
  blocks: fileSchema('blocks', graph),
  verifications: fileSchema(
    'verifications',
    obj(['hash', 'fid', 'kind', 'address', 'protocol', 'timestamp', 'source', 'protocolHash'], {
      hash: hex,
      fid: int,
      kind: { enum: ['add', 'remove'] },
      address: hex,
      protocol: { enum: ['ethereum', 'solana'] },
      chainId: int,
      verificationType: int,
      timestamp: iso,
      source: sourceProtocol,
      protocolHash: hex,
    }),
  ),
  profile: fileSchema(
    'profile',
    obj(['fid', 'protocol', 'protocolHashes', 'client', 'source'], {
      fid: int,
      protocol: { type: 'object', additionalProperties: str },
      protocolHashes: { type: 'object', additionalProperties: hex },
      client: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: { type: ['string', 'integer'] } }] },
      source: { type: 'array', items: { enum: ['protocol', 'client'] } },
    }),
  ),
  'username-proofs': fileSchema(
    'username-proofs',
    obj(['type', 'name', 'owner', 'fid', 'timestamp', 'signature', 'source'], { type: str, name: str, owner: hex, fid: int, timestamp: iso, signature: str, source: sourceProtocol }),
  ),
  signers: fileSchema(
    'signers',
    obj(['key', 'keyType', 'eventType', 'metadataType', 'blockNumber', 'blockTimestamp', 'transactionHash', 'logIndex', 'source'], {
      key: hex,
      keyType: int,
      eventType: { enum: ['add', 'remove', 'admin_reset', 'other'] },
      metadataType: int,
      blockNumber: int,
      blockTimestamp: iso,
      transactionHash: hex,
      logIndex: int,
      source: sourceProtocol,
    }),
  ),
  'onchain-events': fileSchema(
    'onchain-events',
    obj(['type', 'fid', 'blockNumber', 'blockTimestamp', 'transactionHash', 'logIndex', 'event', 'source'], {
      type: str,
      fid: int,
      blockNumber: int,
      blockTimestamp: iso,
      transactionHash: hex,
      logIndex: int,
      event: { type: 'object' },
      source: sourceProtocol,
    }),
  ),
  storage: fileSchema(
    'storage',
    obj(['phase', 'units', 'limits', 'source'], {
      phase: { enum: ['before', 'after'] },
      units: int,
      limits: { type: 'array', items: obj(['name', 'used', 'limit', 'earliestTimestamp'], { name: str, used: int, limit: int, earliestTimestamp: int }) },
      source: sourceProtocol,
    }),
  ),
  channels: fileSchema('channels', obj(['id', 'source'], { id: str, name: str, url: str, followedAt: int, source: { const: 'client' } })),
  'context-casts': fileSchema(
    'context-casts',
    obj(['hash', 'fid', 'found', 'reasons', 'source'], {
      hash: hex,
      fid: int,
      found: bool,
      reasons: { type: 'array', minItems: 1, items: { enum: ['reply_parent', 'reaction_target'] } },
      timestamp: iso,
      text: str,
      embeds: { type: 'array', items: embed },
      parentCastId: castId,
      parentUrl: str,
      source: sourceProtocol,
      protocolHash: hex,
    }),
  ),
};

// Private client data. Written only by --private runs; the schemas are always written.
const sourceClient = { const: 'client' };
Object.assign(SCHEMAS, {
  bookmarks: fileSchema(
    'bookmarks',
    obj(['position', 'inProtocol', 'source'], {
      position: { type: 'integer', minimum: 1 },
      hash: hex,
      fid: int,
      username: str,
      displayName: str,
      timestamp: iso,
      text: str,
      embeds: { type: 'array', items: embed },
      embedsSource: { enum: ['protocol', 'client'] },
      parentHash: hex,
      parentUrl: str,
      threadHash: hex,
      channelKey: str,
      deleted: bool,
      inProtocol: bool,
      protocolHash: hex,
      source: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['client', 'protocol'] } },
    }),
  ),
  'dm-conversations': fileSchema(
    'dm-conversations',
    obj(['index', 'conversationId', 'categories', 'participantFids', 'messages', 'pages', 'exhausted', 'source'], {
      index: { type: 'integer', minimum: 1 },
      conversationId: str,
      categories: { type: 'array', minItems: 1, items: { enum: ['default', 'archived', 'request', 'void'] } },
      isGroup: bool,
      name: str,
      participantFids: { type: 'array', items: int },
      createdAt: iso,
      messages: int,
      pages: int,
      exhausted: bool,
      source: sourceClient,
    }),
  ),
  'dm-messages': fileSchema(
    'dm-messages',
    obj(['conversationId', 'source'], {
      conversationId: str,
      messageId: str,
      senderFid: int,
      timestamp: iso,
      type: str,
      text: str,
      isDeleted: bool,
      inReplyToMessageId: str,
      source: sourceClient,
    }),
  ),
  drafts: fileSchema(
    'drafts',
    obj(['casts', 'source'], {
      draftId: str,
      casts: { type: 'array', items: obj(['embeds'], { text: str, embeds: { type: 'array', items: str } }) },
      parentHash: hex,
      channelKey: str,
      scheduledAt: iso,
      cron: str,
      source: sourceClient,
    }),
  ),
  'muted-keywords': fileSchema('muted-keywords', obj(['keyword', 'source'], { keyword: str, properties: { type: 'object' }, source: sourceClient })),
  'muted-users': fileSchema('muted-users', obj(['source'], { fid: int, username: str, displayName: str, mutedAt: iso, source: sourceClient })),
  'muted-channels': fileSchema('muted-channels', obj(['key', 'source'], { key: str, name: str, source: sourceClient })),
  'mini-apps': fileSchema('mini-apps', obj(['domain', 'source'], { domain: str, name: str, homeUrl: str, iconUrl: str, id: str, authorFid: int, source: sourceClient })),
});

// Closed set of reconciliation reason codes (SPEC output layout).
export const REASON_CODES = ['self_follow', 'hidden_by_client', 'client_only', 'count_mismatch', 'profile_field_mismatch'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const RECONCILIATION_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://fcx.local/schemas/v1/reconciliation.schema.json',
  title: 'fcx reconciliation (schemaVersion 1)',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'fid', 'reasonCodes', 'summary', 'entries'],
  properties: {
    schemaVersion: { const: 1 },
    fid: int,
    reasonCodes: { const: [...REASON_CODES] },
    summary: { type: 'object' },
    entries: {
      type: 'array',
      items: obj(['dataset', 'reason'], {
        dataset: { enum: ['following', 'followers', 'blocks', 'profile'] },
        reason: { enum: [...REASON_CODES] },
        fid: int,
        field: str,
        protocol: {},
        client: {},
        detail: str,
      }),
    },
  },
};
