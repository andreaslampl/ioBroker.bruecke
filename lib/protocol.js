'use strict';

/*
 * Wire protocol between two sites (WebSocket):
 *
 *   server -> client  {t:'hello', v, name, nonce}                       (plain JSON)
 *   client -> server  {t:'auth', v, name, cnonce, mac}                  (plain JSON)
 *                     mac = HMAC-SHA256(key, 'c|' + nonce + '|' + cnonce)
 *   server -> client  {t:'ok', mac}                                     (plain JSON, proves the server knows the key too)
 *                     mac = HMAC-SHA256(key, 's|' + cnonce + '|' + nonce)
 *
 * After that every frame is binary: iv (12) + tag (16) + AES-256-GCM(JSON), with the session key
 * HMAC-SHA256(key, 'k|' + nonce + '|' + cnonce). Each JSON carries a counter `n` per direction (replays are refused).
 * The key itself never goes over the network.
 *
 *   server -> client  {t:'init', points:[{id, write, common, parents, state}]}   all shared data points
 *                     {t:'state', id, state}       a shared value changed (state = {val, ack, ts, lc, q})
 *                     {t:'object', id, common}     its object changed
 *                     {t:'result', ref, ok, error} answer to 'set'
 *   client -> server  {t:'set', ref, id, val}      write a shared data point (only if write is allowed there)
 *   both              {t:'ping'}                   every 15 s; nothing for 45 s = connection dead
 */

const crypto = require('node:crypto');

const VERSION = 1;
const PING_MS = 15000;
const DEAD_MS = 45000;

const hmac = (key, text) => crypto.createHmac('sha256', String(key)).update(text).digest();
const hex = (key, text) => hmac(key, text).toString('hex');

function clientMac(key, nonce, cnonce) {
    return hex(key, `c|${nonce}|${cnonce}`);
}

function serverMac(key, nonce, cnonce) {
    return hex(key, `s|${cnonce}|${nonce}`);
}

/** constant time compare of two hex strings */
function same(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** encrypted channel of one connection; `send` / `open` keep their own counters */
class Channel {
    constructor(key, nonce, cnonce) {
        this.key = hmac(key, `k|${nonce}|${cnonce}`);
        this.out = 0;
        this.in = 0;
    }

    seal(obj) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const body = Buffer.concat([c.update(JSON.stringify({ ...obj, n: ++this.out }), 'utf8'), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), body]);
    }

    /** @returns {object|null} null = forged, damaged or replayed */
    open(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 29) {
            return null;
        }
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
            d.setAuthTag(buf.subarray(12, 28));
            const msg = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
            if (!msg || typeof msg !== 'object' || !(msg.n > this.in)) {
                return null;
            }
            this.in = msg.n;
            return msg;
        } catch {
            return null;
        }
    }
}

/** "Friseursalon" -> "friseursalon", "Haus Süd" -> "haus_sued" */
function slug(name) {
    return (
        String(name || '')
            .trim()
            .toLowerCase()
            .replace(/ä/g, 'ae')
            .replace(/ö/g, 'oe')
            .replace(/ü/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '') || ''
    );
}

/** names used directly below a site's folder by the adapter itself */
const SITE_STATES = ['connected', 'lastSeen', 'remoteName', 'points', 'lastError'];

/** a data point id or a pattern with * (e.g. "spc-edp.0.areas.*") */
function validId(id) {
    return Boolean(id) && id !== '*' && !/[\s?[\]]/.test(id) && !id.includes('..') && !id.startsWith('.') && !id.endsWith('.');
}

/** shares from the settings: [{id, write}] (exact ids before patterns, duplicates merged, write wins) */
function cleanShares(rows) {
    const map = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || r.enabled === false) {
            continue;
        }
        const id = String(r.id || '').trim();
        if (!id || !validId(id)) {
            continue;
        }
        const old = map.get(id);
        map.set(id, { id, write: Boolean(r.write) || Boolean(old && old.write), pattern: id.includes('*') });
    }
    return [...map.values()].sort((a, b) => Number(a.pattern) - Number(b.pattern));
}

/** "spc-edp.0.areas.*" -> RegExp */
function patternRe(p) {
    return new RegExp(`^${p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/** share rule for a concrete id (exact entry first, then the first matching pattern) */
function shareFor(shares, id) {
    for (const s of shares) {
        if (s.pattern ? patternRe(s.id).test(id) : s.id === id) {
            return s;
        }
    }
    return null;
}

/** "10.8.0.2", "10.8.0.2:8102", "ws://host:8102" -> ws URL */
function siteUrl(address, port) {
    let a = String(address || '').trim();
    if (!a) {
        return '';
    }
    if (!/^wss?:\/\//i.test(a)) {
        a = `ws://${a}`;
    }
    try {
        const u = new URL(a);
        if (!u.port) {
            u.port = String(port);
        }
        return `${u.protocol}//${u.host}/`;
    } catch {
        return '';
    }
}

/** sites from the settings: [{name, slug, url, key}] (invalid rows dropped, with a reason) */
function cleanSites(rows, defaultPort) {
    const ok = [];
    const bad = [];
    const used = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || r.enabled === false) {
            continue;
        }
        const name = String(r.name || '').trim();
        const s = slug(name);
        const url = siteUrl(r.address, defaultPort);
        const key = String(r.key || '');
        if (!s || !url) {
            bad.push(`${name || '(ohne Name)'}: Name und Adresse nötig`);
            continue;
        }
        if (key.length < 8) {
            bad.push(`${name}: Schlüssel fehlt oder ist kürzer als 8 Zeichen`);
            continue;
        }
        if (used.has(s) || SITE_STATES.includes(s) || s === 'info') {
            bad.push(`${name}: Name doppelt oder nicht erlaubt`);
            continue;
        }
        used.add(s);
        ok.push({ name, slug: s, url, key });
    }
    return { sites: ok, bad };
}

/** only the parts of a common the other side needs */
function pickCommon(c) {
    const out = {};
    for (const k of ['name', 'type', 'role', 'unit', 'states', 'min', 'max', 'step', 'def', 'desc', 'read', 'write']) {
        if (c && c[k] !== undefined) {
            out[k] = c[k];
        }
    }
    return out;
}

function pickState(st) {
    if (!st) {
        return null;
    }
    return { val: st.val, ack: Boolean(st.ack), ts: st.ts, lc: st.lc, q: st.q || 0 };
}

module.exports = {
    VERSION,
    PING_MS,
    DEAD_MS,
    clientMac,
    serverMac,
    same,
    Channel,
    slug,
    SITE_STATES,
    validId,
    cleanShares,
    patternRe,
    shareFor,
    siteUrl,
    cleanSites,
    pickCommon,
    pickState,
};
