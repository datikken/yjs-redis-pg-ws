import { WebSocket, Data as WSData } from 'ws';
import http from 'http';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness.js'
import * as syncProtocol from 'y-protocols/sync.js';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {pub} from './pubsub.js';
import { getDocUpdatesFromQueue, pushDocUpdatesToQueue } from './redis.js';
import {WSSharedDoc} from "./WsSharedDoc";

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

export const messageSync = 0;
export const messageAwareness = 1;
export const pingTimeout = 30000;
export const docs = new Map<string, WSSharedDoc>();

export function cleanup() {
  docs.forEach((doc) => {
    doc.conns.forEach((_, conn) => {
      closeConn(doc, conn);
    })
  })
}

export default async function setupWSConnection(conn: WebSocket, req: http.IncomingMessage): Promise<void> {
  conn.binaryType = 'arraybuffer';
  const docname: string = req.url?.slice(1).split('?')[0] as string;
  const [doc, isNew] = getYDoc(docname);
  doc.conns.set(conn, new Set());

  conn.on('message', (message: WSData) => {
    messageListener(conn, req, doc, new Uint8Array(message as ArrayBuffer));
  });

  if (isNew) {
    // const persistedUpdates = await getUpdates(doc);
    // const dbYDoc = new Y.Doc()
    //
    // dbYDoc.transact(() => {
    //   for (const u of persistedUpdates) {
    //     Y.applyUpdate(dbYDoc, u.update);
    //   }
    // });
    //
    // Y.applyUpdate(doc, Y.encodeStateAsUpdate(dbYDoc));

    const redisUpdates = await getDocUpdatesFromQueue(doc);
    const redisYDoc = new Y.Doc();
    redisYDoc.transact(() => {
      for (const u of redisUpdates) {
        Y.applyUpdate(redisYDoc, u);
      }
    });

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(redisYDoc));
  }

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) {
        closeConn(doc, conn);
      }
      clearInterval(pingInterval);
    } else if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch (e) {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, pingTimeout);

  conn.on('close', () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);

    // console.log(doc.conns) save document clear updates when doc.conns.length === 0
  });

  conn.on('pong', () => {
    pongReceived = true;
  });

  // put the following in a variables in a block so the interval handlers don't keep them in
  // scope
  {
    // send sync step 1
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())));
      send(doc, conn, encoding.toUint8Array(encoder));
    }
  }
}

export const messageListener = async (conn: WebSocket, req: http.IncomingMessage, doc: WSSharedDoc, message: Uint8Array): Promise<void> => {
  // TODO: authenticate request
  const encoder = encoding.createEncoder();
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case messageSync: {
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn);

      if (encoding.length(encoder) > 1) {
        send(doc, conn, encoding.toUint8Array(encoder));
      }

      break;
    }
    case messageAwareness: {
      const update = decoding.readVarUint8Array(decoder);
      pub.publishBuffer(doc.awarenessChannel, Buffer.from(update));
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, update , conn);
      break;
    }
    default: throw new Error('unreachable');
  }
}

export const getYDoc = (docname: string, gc=true): [WSSharedDoc, boolean] => {
  const existing = docs.get(docname);
  if (existing) {
    return [existing, false];
  }

  const doc = new WSSharedDoc(docname);
  doc.gc = gc;

  docs.set(docname, doc);

  return [doc, true];
}

export const closeConn = (doc: WSSharedDoc, conn: WebSocket): void => {
  const controlledIds = doc.conns.get(conn);
  if (controlledIds) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);

    if (doc.conns.size == 0) {
      doc.destroy();
      docs.delete(doc.name);
    }
  }

  conn.close();
}

export const send = (doc: WSSharedDoc, conn: WebSocket, m: Uint8Array): void => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
  }

  try {
    conn.send(m, err => {
      if (err) {
        closeConn(doc, conn);
      }
    });
  } catch (e) {
    closeConn(doc, conn);
  }
}

export const propagateUpdate = (doc: WSSharedDoc, update: Uint8Array) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
}

export const updateHandler = async (update: Uint8Array, origin: any, doc: WSSharedDoc): Promise<void> => {
  let isOriginWSConn = origin instanceof WebSocket && doc.conns.has(origin);

  if (isOriginWSConn) {
    Promise.all([
      pub.publishBuffer(doc.name, Buffer.from(update)),
      pushDocUpdatesToQueue(doc, update)
    ]); // do not await

    propagateUpdate(doc, update);

    // persistUpdate(doc, update)
    //   .catch((err) => {
    //     serverLogger.error(err);
    //     closeConn(doc, origin);
    //   })
    // ;
  } else {
    propagateUpdate(doc, update);
  }
}
