'use strict';

/*
 * BridgeClient: connection to one other site (its BridgeServer). Reconnects by itself (2 s, 4 s … 60 s).
 * Events: 'connection' (on, why), 'init' (points, remoteName), 'state' (id, state), 'object' (id, common).
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const P = require('./protocol');

const REASONS = {
    4001: 'Schlüssel falsch',
    4003: 'nach mehreren falschen Anmeldungen kurz gesperrt',
};

class BridgeClient extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.url ws://host:port/
     * @param {string} o.key
     * @param {string} o.name name of this site (shown there)
     */
    constructor({ url, key, name, log, pingMs = P.PING_MS, deadMs = P.DEAD_MS, setTimeoutMs = 10000 }) {
        super();
        Object.assign(this, { url, key, name, log, pingMs, deadMs, setTimeoutMs });
        this.connected = false;
        this.backoff = 2000;
        this.pending = new Map(); // ref -> {resolve, timer}
        this.ref = 0;
    }

    start() {
        this.running = true;
        this._connect();
    }

    stop() {
        this.running = false;
        clearTimeout(this.retry);
        clearInterval(this.pinger);
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.on('error', () => {});
            this.ws.terminate();
            this.ws = null;
        }
        this._failAll('Adapter beendet');
    }

    _failAll(why) {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.resolve({ ok: false, error: why });
        }
        this.pending.clear();
    }

    _setConnected(on, why) {
        if (this.connected !== on) {
            this.connected = on;
            this.emit('connection', on, why);
        }
    }

    _connect() {
        if (!this.running) {
            return;
        }
        const ws = new WebSocket(this.url, { handshakeTimeout: 10000, maxPayload: 64 * 1024 * 1024 });
        this.ws = ws;
        let ch = null;
        let why = '';
        let last = Date.now();
        let cnonce = '';
        let nonce = '';
        ws.on('message', (data, binary) => {
            last = Date.now();
            if (!ch) {
                let m = null;
                try {
                    m = binary ? null : JSON.parse(String(data));
                } catch {
                    // nothing
                }
                if (m && m.t === 'hello' && typeof m.nonce === 'string') {
                    nonce = m.nonce;
                    this.remoteName = String(m.name || '');
                    cnonce = crypto.randomBytes(16).toString('hex');
                    ws.send(JSON.stringify({ t: 'auth', v: P.VERSION, name: this.name, cnonce, mac: P.clientMac(this.key, nonce, cnonce) }));
                } else if (m && m.t === 'ok' && nonce && P.same(m.mac, P.serverMac(this.key, nonce, cnonce))) {
                    ch = new P.Channel(this.key, nonce, cnonce);
                    this.ch = ch;
                    this.backoff = 2000;
                    this._setConnected(true);
                } else {
                    why = 'Gegenstelle hat sich nicht richtig ausgewiesen (anderer Schlüssel?)';
                    ws.terminate();
                }
                return;
            }
            const msg = binary ? ch.open(Buffer.from(data)) : null;
            if (!msg) {
                why = 'ungültige Nachricht';
                return ws.terminate();
            }
            this._message(msg);
        });
        ws.on('close', (code, reason) => {
            clearInterval(this.pinger);
            if (this.ws === ws) {
                this.ws = null;
                this.ch = null;
            }
            this._failAll('Verbindung getrennt');
            const text = why || REASONS[code] || (String(reason || '') ? String(reason) : ch ? 'Verbindung getrennt' : 'keine Verbindung');
            this._setConnected(false, text);
            this.emit('down', text);
            if (this.running) {
                this.retry = setTimeout(() => this._connect(), this.backoff);
                this.backoff = Math.min(this.backoff * 2, 60000);
            }
        });
        ws.on('error', err => {
            why = err.code === 'ECONNREFUSED' ? 'nicht erreichbar (Verbindung abgelehnt - läuft dort die Brücke?)' : err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' ? 'nicht erreichbar (VPN / Firewall?)' : err.message;
        });
        clearInterval(this.pinger);
        this.pinger = setInterval(() => {
            if (Date.now() - last > this.deadMs) {
                why = `keine Daten mehr (${Math.round(this.deadMs / 1000)} s)`;
                ws.terminate();
            } else if (ch) {
                this._send({ t: 'ping' });
            }
        }, this.pingMs);
    }

    _send(msg) {
        if (this.ch && this.ws && this.ws.readyState === 1) {
            this.ws.send(this.ch.seal(msg));
            return true;
        }
        return false;
    }

    _message(m) {
        if (m.t === 'init' && Array.isArray(m.points)) {
            this.emit('init', m.points, this.remoteName);
        } else if (m.t === 'state' && typeof m.id === 'string') {
            this.emit('state', m.id, m.state);
        } else if (m.t === 'object' && typeof m.id === 'string') {
            this.emit('object', m.id, m.common || {});
        } else if (m.t === 'result') {
            const p = this.pending.get(m.ref);
            if (p) {
                clearTimeout(p.timer);
                this.pending.delete(m.ref);
                p.resolve({ ok: Boolean(m.ok), error: m.error });
            }
        }
    }

    /** write a data point there; resolves {ok, error} */
    set(id, val) {
        return new Promise(resolve => {
            const ref = ++this.ref;
            if (!this._send({ t: 'set', ref, id, val })) {
                return resolve({ ok: false, error: 'nicht verbunden' });
            }
            const timer = setTimeout(() => {
                this.pending.delete(ref);
                resolve({ ok: false, error: 'keine Antwort' });
            }, this.setTimeoutMs);
            this.pending.set(ref, { resolve, timer });
        });
    }
}

module.exports = { BridgeClient };
