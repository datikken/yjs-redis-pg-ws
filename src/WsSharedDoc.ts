import * as Y from "yjs";
import * as mutex from "lib0/mutex";
import {WebSocket} from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import {sub} from "./pubsub";
import {messageAwareness, send, updateHandler} from "./setupWSConnection";

export class WSSharedDoc extends Y.Doc {
    name: string;
    awarenessChannel: string;
    mux: mutex.mutex;
    conns: Map<WebSocket, Set<number>>;
    awareness: awarenessProtocol.Awareness;

    constructor(name: string) {
        super();

        this.name = name;
        this.awarenessChannel = `${name}-awareness`
        this.mux = mutex.createMutex();
        this.conns = new Map();
        this.awareness = new awarenessProtocol.Awareness(this);

        const awarenessChangeHandler = ({added, updated, removed}: {added: number[], updated: number[], removed: number[]}, origin: any) => {
            const changedClients = added.concat(updated, removed);
            const connControlledIds = this.conns.get(origin);
            if (connControlledIds) {
                added.forEach(clientId => { connControlledIds.add(clientId); });
                removed.forEach(clientId => { connControlledIds.delete(clientId); });
            }

            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
            const buff = encoding.toUint8Array(encoder);

            this.conns.forEach((_, c) => {
                send(this, c, buff);
            });
        }

        this.awareness.on('update', awarenessChangeHandler);
        this.on('update', updateHandler);

        sub.subscribe([this.name, this.awarenessChannel]).then(() => {
            sub.on('messageBuffer', (channel, update) => {
                const channelId = channel.toString();

                // update is a Buffer, Buffer is a subclass of Uint8Array, update can be applied
                // as an update directly

                if (channelId === this.name) {
                    Y.applyUpdate(this, update, sub);
                } else if (channelId === this.awarenessChannel) {
                    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, sub);
                }
            })
        })
    }

    destroy() {
        super.destroy();
        sub.unsubscribe([this.name, this.awarenessChannel]);
    }
}
