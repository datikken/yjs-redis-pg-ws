import Knex from 'knex';
import config from './config.js';
import * as Y from "yjs";
import {WSSharedDoc} from "./WsSharedDoc";

const updatesLimit = 50;

export const knex = Knex({
  client: 'pg',
  connection: {
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name
  }
});

export interface DBUpdate {
  id: string;
  docname: string;
  update: Uint8Array;
}

export const persistUpdate = async (doc: WSSharedDoc, update: Uint8Array): Promise<void> => {
  await knex('items').insert({docname: doc.name, update});
}

export const getUpdates = async (doc: WSSharedDoc): Promise<DBUpdate[]> => {
  const updates = await knex<DBUpdate>('items').where('docname', doc.name).orderBy('id');

  if (updates.length >= updatesLimit) {
    const dbYDoc = new Y.Doc();

    dbYDoc.transact(() => {
      for (const u of updates) {
        Y.applyUpdate(dbYDoc, u.update);
      }
    });

    const [mergedUpdates] = await Promise.all([
      knex<DBUpdate>('items').insert({docname: doc.name, update: Y.encodeStateAsUpdate(dbYDoc)}).returning('*'),
      knex('items').where('docname', doc.name).whereIn('id', updates.map(({id}) => id)).delete()
    ]);

    return mergedUpdates;
  } else {
    return updates;
  }
}
