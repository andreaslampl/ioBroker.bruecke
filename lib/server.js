'use strict';

/*
 * BridgeServer: other sites connect here and get the data points this site shares (see protocol.js).
 * Only clients that know the key get in (HMAC challenge, both ways); after that everything is encrypted.
 * Writes from a site are only carried out for shares with "write" ticked.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const P = require('./protocol');

const MAX_FAILS = 5;
const BLOCK_MS = 60000;

class BridgeServer extends EventEmitter {
    /**
     * @param {object} o
     * @param {number} o.port
     * @param {string} [o.bind] address to listen on ('' = all)
     * @param {string} o.key
     * @param {string} o.name name of this site (shown to the others)
     * @param {() => Promise<object[]>} o.snapshot all shared points [{id, write, common, parents, state}]
     * @param {(id: string) => boolean} o.canWrite
     * @param {(id: string, val: any, site: string) => Promise<void>} o.write
     */
    constructor({ port, bind = '', key, name, snapshot, canWrite, write, log, authMs = 10000, pingMs = P.PING_MS, deadMs = P.DEAD_MS }) {
        super();
        Object.assign(this, { port, bind, key, name, snapshot, canWrite, write, log, authMs, pingMs, deadMs });
        this.clients = new Set();
        this.fails = new Map(); // ip -> {count, until}
    }

    start() {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({ port: this.port, host: this.bind || undefined, maxPayload: 1024 * 1024 });
            this.wss.once('listening', () => {
                this.wss.removeListener('error', reject);
                this.wss.on('error', err => this.log.error(`Brücke: ${err.message}`));
                resolve(this.wss.address().port);
            });
            this.wss.once('error', err => reject(err.code === 'EADDRINUSE' ? new Error(`Port ${this.port} ist schon belegt (anderes Programm oder zweite Instanz)`) : err));
            this.wss.on('connection', (ws, req) => this._connection(ws, req));
            this.pinger = setInterval(() => this._tick(), this.pingMs);
        });
    }

    stop() {
        clearInterval(this.pinger);
        for (const c of this.clients) {
            c.ws.terminate();
        }
        this.clients.clear();
        return new Promise(r => (this.wss ? this.wss.close(() => r()) : r()));
    }

    /** names of the sites connected right now */
    get names() {
        return [...this.clients].filter(c => c.ch).map(c => c.name);
    }

    _blocked(ip) {
        const f = this.fails.get(ip);
        return Boolean(f && f.until > Date.now());
    }

    _fail(ip) {
        const f = this.fails.get(ip) || { count: 0, until: 0 };
        f.count++;
        if (f.count >= MAX_FAILS) {
            f.until = Date.now() + BLOCK_MS;
            f.count = 0;
            this.log.warn(`Brücke: ${MAX_FAILS} falsche Anmeldungen von ${ip} - 1 Minute gesperrt`);
        }
        this.fails.set(ip, f);
    }

    _connection(ws, req) {
        const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (this._blocked(ip)) {
            ws.close(4003, 'gesperrt');
            return;
        }
        const c = { ws, ip, name: '', ch: null, last: Date.now(), nonce: crypto.randomBytes(16).toString('hex') };
        this.clients.add(c);
        const authTimer = setTimeout(() => !c.ch && ws.close(4001, 'keine Anmeldung'), this.authMs);
        ws.on('close', () => {
            clearTimeout(authTimer);
            this.clients.delete(c);
            if (c.ch) {
                this.log.info(`Brücke: ${c.name} (${ip}) getrennt`);
                this.emit('clients', this.names);
            }
        });
        ws.on('error', () => {});
        ws.on('message', (data, binary) => {
            c.last = Date.now();
            if (!c.ch) {
                return this._auth(c, binary ? null : data);
            }
            const msg = binary ? c.ch.open(Buffer.from(data)) : null;
            if (!msg) {
                this.log.warn(`Brücke: ungültige Nachricht von ${c.name} (${ip}) - Verbindung getrennt`);
                return ws.terminate();
            }
            this._message(c, msg);
        });
        ws.send(JSON.stringify({ t: 'hello', v: P.VERSION, name: this.name, nonce: c.nonce }));
    }

    async _auth(c, data) {
        let m = null;
        try {
            m = JSON.parse(String(data));
        } catch {
            // nothing
        }
        if (!m || m.t !== 'auth' || typeof m.cnonce !== 'string' || m.cnonce.length < 16 || !P.same(m.mac, P.clientMac(this.key, c.nonce, m.cnonce))) {
            this._fail(c.ip);
            this.log.warn(`Brücke: Anmeldung von ${c.ip}${m && m.name ? ` (${String(m.name).slice(0, 40)})` : ''} abgelehnt - Schlüssel falsch`);
            c.ws.close(4001, 'Schlüssel falsch');
            return;
        }
        this.fails.delete(c.ip);
        c.name = String(m.name || c.ip).slice(0, 60);
        c.ch = new P.Channel(this.key, c.nonce, m.cnonce);
        c.ws.send(JSON.stringify({ t: 'ok', mac: P.serverMac(this.key, c.nonce, m.cnonce) }));
        this.log.info(`Brücke: ${c.name} (${c.ip}) verbunden`);
        this.emit('clients', this.names);
        try {
            const points = await this.snapshot();
            this._send(c, { t: 'init', points });
        } catch (err) {
            this.log.warn(`Brücke: Liste der Datenpunkte für ${c.name}: ${err.message}`);
        }
    }

    _send(c, msg) {
        if (c.ch && c.ws.readyState === 1) {
            c.ws.send(c.ch.seal(msg));
        }
    }

    broadcast(msg) {
        for (const c of this.clients) {
            this._send(c, msg);
        }
    }

    /** a shared value changed */
    stateChanged(id, state) {
        this.broadcast({ t: 'state', id, state: P.pickState(state) });
    }

    objectChanged(id, common) {
        this.broadcast({ t: 'object', id, common: P.pickCommon(common) });
    }

    /** list of shared points changed (settings or new objects of a pattern): send everything again */
    async resend() {
        if (![...this.clients].some(c => c.ch)) {
            return;
        }
        const points = await this.snapshot();
        this.broadcast({ t: 'init', points });
    }

    async _message(c, m) {
        if (m.t === 'ping') {
            return;
        }
        if (m.t !== 'set') {
            return;
        }
        const id = String(m.id || '');
        const reply = (ok, error) => this._send(c, { t: 'result', ref: m.ref, id, ok, ...(error ? { error } : {}) });
        if (!this.canWrite(id)) {
            this.log.warn(`Brücke: ${c.name} wollte ${id} schalten - nicht zum Schalten freigegeben`);
            return reply(false, 'nicht zum Schalten freigegeben');
        }
        if (m.val !== null && !['boolean', 'number', 'string'].includes(typeof m.val)) {
            return reply(false, 'ungültiger Wert');
        }
        try {
            await this.write(id, m.val, c.name);
            reply(true);
        } catch (err) {
            reply(false, err.message);
        }
    }

    _tick() {
        const now = Date.now();
        for (const c of this.clients) {
            if (now - c.last > this.deadMs) {
                c.ws.terminate();
            } else {
                this._send(c, { t: 'ping' });
            }
        }
        for (const [ip, f] of this.fails) {
            if (f.until && f.until < now) {
                this.fails.delete(ip);
            }
        }
    }
}

module.exports = { BridgeServer };
