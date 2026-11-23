'use strict';

/*
 * Fake adapter-core: every adapter gets its own FakeDb (= one ioBroker installation / site), so two or three
 * sites run in one test process. States and objects of the db, subscriptions with patterns, stateChange /
 * objectChange like js-controller (also for the adapter's own writes).
 */

const Module = require('node:module');
const { EventEmitter } = require('node:events');

const re = p => new RegExp(`^${p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

class FakeDb {
    constructor() {
        this.objects = {};
        this.states = {};
        this.adapters = new Set();
    }

    setObject(id, obj) {
        this.objects[id] = obj;
        for (const a of this.adapters) {
            a._objChanged(id, obj);
        }
    }

    delObject(id) {
        delete this.objects[id];
        for (const a of this.adapters) {
            a._objChanged(id, null);
        }
    }

    /** a device / another adapter writes a value */
    setState(id, val, ack = true, from = 'system.adapter.test.0') {
        const old = this.states[id];
        const st = typeof val === 'object' && val !== null ? { ...val } : { val };
        const now = Date.now();
        const state = { val: st.val, ack: st.ack !== undefined ? Boolean(st.ack) : Boolean(ack), ts: st.ts || now, q: st.q || 0, from: st.from || from };
        state.lc = st.lc || (old && old.val === state.val ? old.lc : state.ts);
        this.states[id] = state;
        for (const a of this.adapters) {
            a._stateChanged(id, state);
        }
        return state;
    }

    /** a data point with an object, like an adapter creates it */
    point(id, common, val) {
        this.setObject(id, { type: 'state', common: { read: true, write: true, ...common }, native: {} });
        if (val !== undefined) {
            this.setState(id, val, true);
        }
    }
}

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.name = options.name;
        this.namespace = `${options.name}.${options.instance || 0}`;
        this.config = options.config || {};
        this.db = options.db || new FakeDb();
        this.db.adapters.add(this);
        this.subs = [];
        this.objSubs = [];
        this.logs = [];
        const log = level => m => this.logs.push(`${level}: ${m}`);
        this.log = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
    }

    _id(id) {
        return id.startsWith(`${this.namespace}.`) || id === this.namespace ? id : `${this.namespace}.${id}`;
    }

    _stateChanged(id, state) {
        const own = id.startsWith(`${this.namespace}.`);
        if (this.subs.some(r => r.test(id)) || (own && this.ownAll)) {
            setImmediate(() => this.emit('stateChange', id, { ...state }));
        }
    }

    _objChanged(id, obj) {
        if (this.objSubs.some(r => r.test(id))) {
            setImmediate(() => this.emit('objectChange', id, obj));
        }
    }

    // objects
    async extendObject(id, obj) {
        const full = this._id(id);
        const old = this.db.objects[full];
        const merged = old ? { ...old, ...obj, common: { ...old.common, ...(obj.common || {}) }, native: { ...old.native, ...(obj.native || {}) } } : { native: {}, ...obj };
        this.db.setObject(full, merged);
    }
    async setObjectNotExistsAsync(id, obj) {
        if (!this.db.objects[this._id(id)]) {
            this.db.setObject(this._id(id), obj);
        }
    }
    async getObjectAsync(id) {
        return this.db.objects[this._id(id)] || null;
    }
    async getForeignObjectAsync(id) {
        return this.db.objects[id] || null;
    }
    async getForeignObjectsAsync(pattern, type) {
        const r = re(pattern);
        const out = {};
        for (const [id, o] of Object.entries(this.db.objects)) {
            if (r.test(id) && (!type || o.type === type)) {
                out[id] = o;
            }
        }
        return out;
    }
    async getAdapterObjectsAsync() {
        return this.getForeignObjectsAsync(`${this.namespace}.*`);
    }
    async delObjectAsync(id, opts = {}) {
        const full = this._id(id);
        for (const k of Object.keys(this.db.objects)) {
            if (k === full || (opts.recursive && k.startsWith(`${full}.`))) {
                this.db.delObject(k);
                delete this.db.states[k];
            }
        }
    }
    async delForeignObjectAsync(id) {
        this.db.delObject(id);
    }

    // states
    async setState(id, val, ack) {
        this.db.setState(this._id(id), { val, ack: Boolean(ack), from: `system.adapter.${this.namespace}` });
    }
    async setStateAsync(id, state) {
        this.db.setState(this._id(id), { ...state, from: `system.adapter.${this.namespace}` });
    }
    async getStateAsync(id) {
        return this.db.states[this._id(id)] || null;
    }
    async getForeignStateAsync(id) {
        return this.db.states[id] || null;
    }
    async setForeignStateAsync(id, val, ack) {
        this.db.setState(id, { val, ack: Boolean(ack), from: `system.adapter.${this.namespace}` });
    }
    subscribeForeignStates(p) {
        this.subs.push(re(p));
    }
    subscribeStates(p) {
        if (p === '*') {
            this.ownAll = true;
        } else {
            this.subs.push(re(this._id(p)));
        }
    }
    subscribeForeignObjects(p) {
        this.objSubs.push(re(p));
    }

    val(id) {
        const s = this.db.states[this._id(id)] || this.db.states[id];
        return s ? s.val : undefined;
    }
}

function install() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter };
        }
        return orig.call(this, request, ...rest);
    };
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { FakeDb, FakeAdapter, install, until };
