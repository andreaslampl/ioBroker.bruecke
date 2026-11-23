'use strict';

/*
 * ioBroker.bruecke - passes chosen data points between ioBroker installations at different sites (e.g. home, shop):
 *  - "Freigaben": data points (or patterns like spc-edp.0.areas.*) this site offers to the others, each read only or
 *    read + write. Other sites connect to our port with the key.
 *  - "Standorte": other sites we connect to; their shared data points appear here as
 *    bruecke.0.<site>.<original id> (same type / role / unit / texts), writable ones send commands there.
 * Every site keeps working on its own; without a connection only <site>.connected turns false.
 */

const utils = require('@iobroker/adapter-core');
const P = require('./lib/protocol');
const { BridgeServer } = require('./lib/server');
const { BridgeClient } = require('./lib/client');

const MAX_POINTS = 2000;

const ro = (name, type, role, extra = {}) => ({ type: 'state', common: { name, type, role, read: true, write: false, ...extra }, native: {} });

const SITE_OBJECTS = {
    connected: ro('Verbunden', 'boolean', 'indicator.connected', { def: false }),
    lastSeen: ro('Zuletzt verbunden', 'number', 'date'),
    remoteName: ro('Name des Standorts (dort eingestellt)', 'string', 'text'),
    points: ro('Anzahl Datenpunkte von dort', 'number', 'value'),
    lastError: ro('Letzter Fehler', 'string', 'text'),
};

/** value converted to the mirrored object's type (e.g. "1" -> 1 for number) */
function typed(val, type) {
    if (val === null || val === undefined) {
        return val;
    }
    if (type === 'number') {
        const n = typeof val === 'boolean' ? Number(val) : Number(String(val).replace(',', '.'));
        return Number.isFinite(n) ? n : val;
    }
    if (type === 'boolean') {
        if (typeof val === 'string') {
            return !['false', '0', '', 'off', 'aus'].includes(val.trim().toLowerCase());
        }
        return Boolean(val);
    }
    if (type === 'string' && typeof val !== 'string') {
        return String(val);
    }
    return val;
}

class Bruecke extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'bruecke' });
        this.exported = new Map(); // id -> {write, common}
        this.parentNames = new Map(); // id -> name of the folder / channel / device
        this.sites = new Map(); // slug -> {cfg, client, remote: Map(remoteId -> {write, type, last})}
        this.local = new Map(); // own id -> {site, remote}
        this.timers = new Set();
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    get siteName() {
        return String(this.config.name || '').trim() || 'ioBroker';
    }

    async onReady() {
        await this.extendObject('info', { type: 'channel', common: { name: 'Information' }, native: {} });
        await this.extendObject('info.connection', ro('Alle Standorte verbunden', 'boolean', 'indicator.connected', { def: false }));
        await this.extendObject('info.clients', ro('Verbunden zu uns: Standorte', 'string', 'text'));
        await this.extendObject('info.shared', ro('Anzahl freigegebener Datenpunkte', 'number', 'value'));
        await this.setState('info.connection', false, true);
        await this.setState('info.clients', '', true);

        this.shares = P.cleanShares(this.config.shares);
        const port = Number(this.config.port) || 8102;
        const key = String(this.config.key || '');
        if (this.shares.length) {
            if (key.length < 8) {
                this.log.error('Freigaben: Zugriffsschlüssel fehlt oder ist kürzer als 8 Zeichen - es wird nichts freigegeben');
            } else {
                await this.startServer(port, key);
            }
        } else {
            this.log.info('Keine Freigaben - andere Standorte können sich mit diesem Standort nicht verbinden (nur nötig, wenn hier etwas freigegeben wird)');
        }
        await this.startSites(port);
        if (!this.shares.length && !this.sites.size) {
            this.log.warn('Noch nichts eingestellt: weder Freigaben noch Standorte');
        }
    }

    // ---------------- sharing (server) ----------------

    async startServer(port, key) {
        await this.expandFolders();
        await this.collectShares();
        this.server = new BridgeServer({
            port,
            bind: String(this.config.bind || '').trim(),
            key,
            name: this.siteName,
            log: this.log,
            snapshot: () => this.snapshot(),
            canWrite: id => Boolean(this.exported.get(id) && this.exported.get(id).write),
            write: async (id, val, site) => {
                const e = this.exported.get(id);
                const v = typed(val, e && e.common.type);
                this.log.info(`Befehl von ${site}: ${id} = ${JSON.stringify(v)}`);
                await this.setForeignStateAsync(id, v, false);
            },
        });
        this.server.on('clients', names => this.setState('info.clients', names.join(', '), true));
        try {
            const p = await this.server.start();
            this.log.info(`Freigabe: ${this.exported.size} Datenpunkt(e) auf Port ${p} für andere Standorte`);
        } catch (err) {
            this.log.error(`Freigabe nicht möglich: ${err.message}`);
            this.server = null;
            return;
        }
        for (const s of this.shares) {
            this.subscribeForeignStates(s.id);
            this.subscribeForeignObjects(s.id);
        }
    }

    /** a folder / channel / device / adapter instance = everything below it (id.*) */
    async expandFolders() {
        for (const s of this.shares) {
            if (s.pattern) {
                continue;
            }
            const o = await this.getForeignObjectAsync(s.id).catch(() => null);
            // a whole adapter instance ("spc-edp.0") often has no object of its own, only objects below it
            const below = !o && Object.keys((await this.getForeignObjectsAsync(`${s.id}.*`, 'state').catch(() => ({}))) || {}).length > 0;
            if ((o && o.type !== 'state') || below) {
                s.id = `${s.id}.*`;
                s.pattern = true;
            }
        }
        this.shares = P.cleanShares(this.shares);
    }

    /** resolve the share list (patterns) into concrete state objects */
    async collectShares() {
        const found = new Map();
        for (const s of this.shares) {
            let objs = {};
            if (s.pattern) {
                objs = (await this.getForeignObjectsAsync(s.id, 'state').catch(() => ({}))) || {};
            } else {
                const o = await this.getForeignObjectAsync(s.id).catch(() => null);
                if (!o) {
                    this.log.warn(`Freigabe: Datenpunkt ${s.id} gibt es nicht`);
                } else {
                    objs[s.id] = o;
                }
            }
            for (const [id, o] of Object.entries(objs)) {
                if (found.has(id) || !o || o.type !== 'state') {
                    continue;
                }
                if (found.size >= MAX_POINTS) {
                    this.log.warn(`Freigabe: mehr als ${MAX_POINTS} Datenpunkte - der Rest wird nicht freigegeben`);
                    break;
                }
                const rule = P.shareFor(this.shares, id) || s;
                found.set(id, { write: rule.write, common: P.pickCommon(o.common) });
            }
        }
        this.exported = found;
        await this.setState('info.shared', found.size, true);
        await this.collectParents();
    }

    /** names of the folders above the shared points, so the other site shows the same tree */
    async collectParents() {
        const need = new Set();
        for (const id of this.exported.keys()) {
            const parts = id.split('.');
            for (let i = 2; i < parts.length; i++) {
                need.add(parts.slice(0, i).join('.'));
            }
        }
        for (const p of need) {
            if (!this.parentNames.has(p)) {
                const o = await this.getForeignObjectAsync(p).catch(() => null);
                this.parentNames.set(p, o && o.common ? o.common.name : null);
            }
        }
    }

    async snapshot() {
        const points = [];
        for (const [id, e] of this.exported) {
            const st = await this.getForeignStateAsync(id).catch(() => null);
            const parents = {};
            const parts = id.split('.');
            for (let i = 2; i < parts.length; i++) {
                const p = parts.slice(0, i).join('.');
                const n = this.parentNames.get(p);
                if (n) {
                    parents[p] = n;
                }
            }
            points.push({ id, write: e.write, common: e.common, parents, state: P.pickState(st) });
        }
        return points;
    }

    _later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }

    async onObjectChange(id, obj) {
        if (!this.server) {
            return;
        }
        const e = this.exported.get(id);
        if (e && obj && obj.type === 'state') {
            e.common = P.pickCommon(obj.common);
            this.server.objectChanged(id, e.common);
            return;
        }
        // new or deleted object of a pattern: resolve the list again (a moment later, objects come in bursts)
        if ((e && !obj) || (!e && obj && obj.type === 'state' && P.shareFor(this.shares, id))) {
            clearTimeout(this.reshare);
            this.reshare = this._later(async () => {
                await this.collectShares();
                await this.server.resend().catch(err => this.log.warn(`Freigabe: ${err.message}`));
            }, 2000);
        }
    }

    // ---------------- other sites (clients) ----------------

    async startSites(port) {
        const { sites, bad } = P.cleanSites(this.config.sites, port);
        for (const b of bad) {
            this.log.warn(`Standort übersprungen: ${b}`);
        }
        await this.removeOldSites(sites.map(s => s.slug));
        for (const cfg of sites) {
            await this.extendObject(cfg.slug, { type: 'device', common: { name: cfg.name }, native: { bridgeSite: true } });
            for (const [k, obj] of Object.entries(SITE_OBJECTS)) {
                await this.extendObject(`${cfg.slug}.${k}`, obj);
            }
            await this.setState(`${cfg.slug}.connected`, false, true);
            const site = { cfg, remote: new Map() };
            await this.loadMirrors(site);
            const client = new BridgeClient({ url: cfg.url, key: cfg.key, name: this.siteName, log: this.log });
            site.client = client;
            client.on('connection', on => this.onConnection(site, on));
            client.on('down', why => this.onDown(site, why));
            client.on('init', (points, remoteName) => this.onInit(site, points, remoteName).catch(err => this.log.warn(`${cfg.name}: ${err.message}`)));
            client.on('state', (id, st) => this.onRemoteState(site, id, st));
            client.on('object', (id, common) => this.onRemoteObject(site, id, common));
            this.sites.set(cfg.slug, site);
            client.start();
        }
        if (this.sites.size) {
            this.subscribeStates('*');
        }
        await this.updateConnection();
    }

    /** sites removed from the settings: delete their objects */
    async removeOldSites(keep) {
        const objs = (await this.getAdapterObjectsAsync().catch(() => ({}))) || {};
        for (const [id, o] of Object.entries(objs)) {
            if (o.type === 'device' && o.native && o.native.bridgeSite) {
                const s = id.slice(this.namespace.length + 1);
                if (!keep.includes(s)) {
                    this.log.info(`Standort ${s} ist nicht mehr eingestellt - seine Datenpunkte werden gelöscht`);
                    await this.delObjectAsync(s, { recursive: true }).catch(() => {});
                }
            }
        }
    }

    /** mirrors from the last run (so commands work right after a start, before the site answered) */
    async loadMirrors(site) {
        const objs = (await this.getForeignObjectsAsync(`${this.namespace}.${site.cfg.slug}.*`, 'state').catch(() => ({}))) || {};
        for (const o of Object.values(objs)) {
            if (o.native && o.native.remote) {
                this.track(site, o.native.remote, Boolean(o.common.write), o.common.type);
            }
        }
    }

    mirrorId(site, remote) {
        return `${site.cfg.slug}.${remote}`;
    }

    track(site, remote, write, type) {
        const r = site.remote.get(remote) || {};
        Object.assign(r, { write, type });
        site.remote.set(remote, r);
        this.local.set(`${this.namespace}.${this.mirrorId(site, remote)}`, { site, remote });
    }

    async onConnection(site, on) {
        await this.setState(`${site.cfg.slug}.connected`, on, true);
        await this.setState(`${site.cfg.slug}.lastSeen`, Date.now(), true);
        if (on) {
            const rn = site.client.remoteName;
            this.log.info(`${site.cfg.name}: verbunden${rn && rn !== site.cfg.name ? ` (dort heißt der Standort „${rn}“)` : ''}`);
            await this.setState(`${site.cfg.slug}.remoteName`, rn || '', true);
            await this.setState(`${site.cfg.slug}.lastError`, '', true);
            site.lastWhy = '';
        }
        await this.updateConnection();
    }

    /** connection lost or a try failed: logged once per reason (retries every 2…60 s) */
    async onDown(site, why) {
        await this.setState(`${site.cfg.slug}.lastError`, why, true);
        if (site.lastWhy !== why) {
            this.log.warn(`${site.cfg.name}: ${why} - neuer Versuch läuft`);
        }
        site.lastWhy = why;
    }

    async updateConnection() {
        const all = [...this.sites.values()];
        await this.setState('info.connection', all.length > 0 && all.every(s => s.client && s.client.connected), true);
    }

    async folder(id, name, type = 'folder') {
        const old = await this.getObjectAsync(id).catch(() => null);
        if (!old) {
            await this.setObjectNotExistsAsync(id, { type, common: { name }, native: {} });
        } else if (name && old.type !== 'state' && JSON.stringify(old.common && old.common.name) !== JSON.stringify(name)) {
            await this.extendObject(id, { common: { name } });
        }
    }

    async onInit(site, points, remoteName) {
        const name = site.cfg.name;
        const seen = new Set();
        const folders = new Map();
        for (const p of points) {
            if (!p || typeof p.id !== 'string' || !P.validId(p.id) || p.id.includes('*')) {
                continue;
            }
            const first = p.id.split('.')[0];
            if (P.SITE_STATES.includes(first)) {
                continue; // would collide with connected / lastSeen …
            }
            seen.add(p.id);
            const parts = p.id.split('.');
            for (let i = 1; i < parts.length; i++) {
                const rid = parts.slice(0, i).join('.');
                if (!folders.has(rid)) {
                    folders.set(rid, (p.parents && p.parents[rid]) || parts[i - 1]);
                }
            }
            const common = { ...P.pickCommon(p.common), read: true, write: Boolean(p.write) };
            if (!common.type) {
                common.type = 'mixed';
            }
            if (!common.role) {
                common.role = 'state';
            }
            if (!common.name) {
                common.name = parts[parts.length - 1];
            }
            const own = this.mirrorId(site, p.id);
            await this.extendObject(own, { type: 'state', common, native: { remote: p.id, site: remoteName || name } });
            this.track(site, p.id, Boolean(p.write), common.type);
            if (p.state) {
                await this.writeMirror(site, p.id, p.state, true);
            }
        }
        for (const [rid, n] of folders) {
            await this.folder(this.mirrorId(site, rid), n);
        }
        // shares that are gone there
        for (const remote of [...site.remote.keys()]) {
            if (!seen.has(remote)) {
                site.remote.delete(remote);
                this.local.delete(`${this.namespace}.${this.mirrorId(site, remote)}`);
                await this.delObjectAsync(this.mirrorId(site, remote)).catch(() => {});
            }
        }
        await this.removeEmptyFolders(site);
        await this.setState(`${site.cfg.slug}.points`, seen.size, true);
        const w = [...site.remote.values()].filter(r => r.write).length;
        this.log.info(`${name}: ${seen.size} Datenpunkt(e) übernommen${w ? `, ${w} davon schaltbar` : ''}`);
    }

    async removeEmptyFolders(site) {
        const prefix = `${this.namespace}.${site.cfg.slug}.`;
        const objs = (await this.getForeignObjectsAsync(`${prefix}*`).catch(() => ({}))) || {};
        const ids = Object.keys(objs);
        for (const [id, o] of Object.entries(objs)) {
            if (o.type === 'folder' && !ids.some(x => x.startsWith(`${id}.`) && objs[x].type === 'state')) {
                await this.delForeignObjectAsync(id).catch(() => {});
            }
        }
    }

    async writeMirror(site, remote, st, init = false) {
        const r = site.remote.get(remote);
        if (!r || !st) {
            return;
        }
        r.last = st;
        const own = this.mirrorId(site, remote);
        if (init) {
            const cur = await this.getStateAsync(own).catch(() => null);
            if (cur && cur.ack && cur.val === st.val && cur.ts === st.ts) {
                return;
            }
        }
        const state = { val: st.val, ack: true, q: st.q || 0 };
        if (Number.isFinite(st.ts)) {
            state.ts = st.ts;
        }
        if (Number.isFinite(st.lc)) {
            state.lc = st.lc;
        }
        await this.setStateAsync(own, state).catch(err => this.log.debug(`${own}: ${err.message}`));
    }

    onRemoteState(site, remote, st) {
        this.writeMirror(site, remote, st);
    }

    async onRemoteObject(site, remote, common) {
        const r = site.remote.get(remote);
        if (!r) {
            return;
        }
        const c = { ...P.pickCommon(common), read: true, write: r.write };
        r.type = c.type || r.type;
        await this.extendObject(this.mirrorId(site, remote), { common: c }).catch(() => {});
    }

    // ---------------- local commands to a mirrored point ----------------

    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (!id.startsWith(`${this.namespace}.`)) {
            // a shared data point of this site
            if (this.server && this.exported.has(id)) {
                this.server.stateChanged(id, state);
            }
            return;
        }
        if (state.ack) {
            return;
        }
        const m = this.local.get(id);
        if (!m) {
            return;
        }
        const { site, remote } = m;
        const r = site.remote.get(remote);
        const restore = () => (r && r.last ? this.writeMirror(site, remote, r.last) : Promise.resolve());
        if (!r || !r.write) {
            this.log.warn(`${id}: am Standort ${site.cfg.name} nicht zum Schalten freigegeben`);
            return restore();
        }
        const val = typed(state.val, r.type);
        this.log.info(`${site.cfg.name}: ${remote} = ${JSON.stringify(val)} (von ${state.from || '?'})`);
        const res = await site.client.set(remote, val);
        if (!res.ok) {
            this.log.warn(`${site.cfg.name}: ${remote} schalten nicht möglich - ${res.error || 'unbekannt'}`);
            await this.setState(`${site.cfg.slug}.lastError`, `${remote}: ${res.error || 'Schalten nicht möglich'}`, true);
            return restore();
        }
        // the value with ack comes back from there as soon as the device confirmed it
    }

    async onUnload(callback) {
        try {
            for (const t of this.timers) {
                clearTimeout(t);
            }
            for (const s of this.sites.values()) {
                s.client && s.client.stop();
            }
            if (this.server) {
                await this.server.stop();
            }
        } catch {
            // nothing
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = options => new Bruecke(options);
    module.exports.typed = typed;
} else {
    new Bruecke();
}
