'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const P = require('../lib/protocol');
const { FakeDb, install, until } = require('./fake');

install();
const create = require('../main.js');

const KEY = 'geheim-12345';

function freePort() {
    return new Promise(r => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => r(p));
        });
    });
}

function start(t, db, config) {
    const a = create({ db, config });
    a.emit('ready');
    t.after(() => stop(a));
    return a;
}

function stop(a) {
    if (a.stopped) {
        return Promise.resolve();
    }
    a.stopped = true;
    return new Promise(r => a.emit('unload', r));
}

const has = (a, text) => a.logs.some(l => l.includes(text));

test('protocol: names, shares, sites, addresses', () => {
    assert.equal(P.slug('Friseursalon'), 'friseursalon');
    assert.equal(P.slug(' Haus Süd '), 'haus_sued');
    assert.equal(P.slug('***'), '');
    const shares = P.cleanShares([
        { id: 'spc-edp.0.areas.*', write: false },
        { id: 'spc-edp.0.areas.1.setMode', write: true },
        { id: 'bad id', write: true },
        { id: '*', write: true },
        { id: 'x.0.y', enabled: false },
    ]);
    assert.deepEqual(
        shares.map(s => s.id),
        ['spc-edp.0.areas.1.setMode', 'spc-edp.0.areas.*'],
    );
    assert.equal(P.shareFor(shares, 'spc-edp.0.areas.1.setMode').write, true, 'exact entry before pattern');
    assert.equal(P.shareFor(shares, 'spc-edp.0.areas.1.mode').write, false);
    assert.equal(P.shareFor(shares, 'spc-edp.0.zones.1.open'), null);
    const nested = P.cleanShares([{ id: 'spc-edp.0.*' }, { id: 'spc-edp.0.areas.1.*', write: true }]);
    assert.equal(P.shareFor(nested, 'spc-edp.0.areas.1.setMode').write, true, 'more specific folder wins');
    assert.equal(P.shareFor(nested, 'spc-edp.0.areas.2.setMode').write, false);
    assert.equal(P.siteUrl('10.8.0.2', 8102), 'ws://10.8.0.2:8102/');
    assert.equal(P.siteUrl('10.8.0.2:9000', 8102), 'ws://10.8.0.2:9000/');
    assert.equal(P.siteUrl('salon.local', 8102), 'ws://salon.local:8102/');
    const { sites, bad } = P.cleanSites(
        [
            { name: 'Friseursalon', address: '10.8.0.2', key: KEY },
            { name: 'friseursalon', address: '10.8.0.3', key: KEY },
            { name: 'Solarium', address: '10.8.0.4', key: 'kurz' },
            { name: '', address: '10.8.0.5', key: KEY },
            { name: 'Aus', address: '10.8.0.6', key: KEY, enabled: false },
        ],
        8102,
    );
    assert.deepEqual(
        sites.map(s => s.slug),
        ['friseursalon'],
    );
    assert.equal(bad.length, 3);
});

test('client: connection errors explained', () => {
    const { explain } = require('../lib/client');
    assert.match(explain(new Error('Opening handshake has timed out')), /keine Antwort/);
    assert.match(explain(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), /abgelehnt/);
    assert.match(explain(new Error('Unexpected server response: 404')), /anderes Programm/);
});

test('protocol: handshake macs, encryption, replay and forgery refused', () => {
    const nonce = 'a'.repeat(32);
    const cnonce = 'b'.repeat(32);
    assert.ok(P.same(P.clientMac(KEY, nonce, cnonce), P.clientMac(KEY, nonce, cnonce)));
    assert.ok(!P.same(P.clientMac(KEY, nonce, cnonce), P.clientMac('anders-12345', nonce, cnonce)));
    assert.notEqual(P.clientMac(KEY, nonce, cnonce), P.serverMac(KEY, nonce, cnonce), 'a client answer cannot be sent back as server proof');
    const a = new P.Channel(KEY, nonce, cnonce);
    const b = new P.Channel(KEY, nonce, cnonce);
    const f1 = a.seal({ t: 'state', id: 'x', state: { val: 1 } });
    assert.ok(!f1.toString('utf8').includes('state'), 'not readable on the wire');
    assert.equal(b.open(f1).state.val, 1);
    assert.equal(b.open(f1), null, 'replay');
    const f2 = a.seal({ t: 'ping' });
    f2[40] ^= 1;
    assert.equal(b.open(f2), null, 'changed byte');
    const other = new P.Channel('anders-12345', nonce, cnonce);
    assert.equal(other.open(a.seal({ t: 'ping' })), null, 'other key');
});

/** salon = site with the alarm system, home = site that wants to see it */
async function twoSites(t, { homeKey = KEY } = {}) {
    const port = await freePort();
    const salon = new FakeDb();
    salon.setObject('spc-edp.0.areas', { type: 'folder', common: { name: 'Bereiche' }, native: {} });
    salon.setObject('spc-edp.0.areas.1', { type: 'channel', common: { name: 'Salon' }, native: {} });
    salon.point('spc-edp.0.areas.1.mode', { name: 'Zustand', type: 'number', role: 'value', states: { 0: 'Unscharf', 3: 'Scharf' } }, 0);
    salon.point('spc-edp.0.areas.1.setMode', { name: 'Schalten', type: 'number', role: 'level', states: { 0: 'Unscharf', 3: 'Scharf' } }, 0);
    salon.point('spc-edp.0.areas.1.ready', { name: 'Scharfschaltbereit', type: 'boolean', role: 'indicator' }, true);
    salon.point('spc-edp.0.areas.1.openInputs', { name: 'Offene Melder', type: 'string', role: 'text' }, '');
    salon.point('shelly.0.licht.on', { name: 'Licht Eingang', type: 'boolean', role: 'switch' }, false);
    const salonA = start(t, salon, {
        name: 'Friseursalon',
        port,
        key: KEY,
        shares: [
            { id: 'spc-edp.0.areas', write: false }, // folder picked in the object tree = everything below
            { id: 'spc-edp.0.areas.1.setMode', write: true },
        ],
    });
    await until(() => salonA.server && salonA.server.wss);
    assert.ok(salonA.shares.some(x => x.id === 'spc-edp.0.areas.*'));
    const home = new FakeDb();
    const homeA = start(t, home, { name: 'Daheim', sites: [{ name: 'Friseursalon', address: `127.0.0.1:${port}`, key: homeKey }] });
    return { port, salon, salonA, home, homeA };
}

const M = 'bruecke.0.friseursalon.spc-edp.0.areas.1';

test('sharing: values, objects, folder names, changes, commands, read only', async t => {
    const { salon, salonA, home, homeA } = await twoSites(t);
    await until(() => homeA.val('friseursalon.connected') === true);
    await until(() => homeA.val('friseursalon.points') === 4);
    assert.equal(homeA.val('info.connection'), true);
    assert.equal(salonA.val('info.shared'), 4);
    await until(() => salonA.val('info.clients') === 'Daheim');
    assert.ok(!home.objects['bruecke.0.friseursalon.shelly.0.licht.on'], 'not shared');
    // same object as at the salon, the folder name comes along
    const obj = home.objects[`${M}.mode`];
    assert.equal(obj.common.type, 'number');
    assert.deepEqual(obj.common.states, { 0: 'Unscharf', 3: 'Scharf' });
    assert.equal(obj.common.write, false);
    assert.equal(home.objects[`${M}.setMode`].common.write, true);
    assert.equal(home.objects[M].common.name, 'Salon');
    assert.equal(home.objects['bruecke.0.friseursalon.spc-edp.0.areas'].common.name, 'Bereiche');
    assert.equal(home.objects['bruecke.0.friseursalon'].type, 'device');
    assert.equal(home.states[`${M}.ready`].val, true);
    assert.equal(home.states[`${M}.ready`].ack, true);

    // a change at the salon arrives at home with the salon's time
    const st = salon.setState('spc-edp.0.areas.1.openInputs', 'Eingangstür', true);
    await until(() => home.states[`${M}.openInputs`] && home.states[`${M}.openInputs`].val === 'Eingangstür');
    assert.equal(home.states[`${M}.openInputs`].ts, st.ts);

    // home (e.g. SmartView) arms the salon: command goes there with ack false, typed
    home.setState(`${M}.setMode`, '3', false, 'system.adapter.smartview.0');
    await until(() => salon.states['spc-edp.0.areas.1.setMode'].val === 3);
    assert.equal(salon.states['spc-edp.0.areas.1.setMode'].ack, false);
    assert.ok(has(salonA, 'Befehl von Daheim: spc-edp.0.areas.1.setMode = 3'));
    // the alarm adapter there confirms -> ack true at home
    salon.setState('spc-edp.0.areas.1.setMode', 3, true);
    salon.setState('spc-edp.0.areas.1.mode', 3, true);
    await until(() => home.states[`${M}.mode`].val === 3 && home.states[`${M}.setMode`].ack === true);

    // read only: refused, the old value comes back, nothing written at the salon
    home.setState(`${M}.ready`, false, false, 'system.adapter.admin.0');
    await until(() => home.states[`${M}.ready`].ack === true);
    assert.equal(home.states[`${M}.ready`].val, true);
    assert.equal(salon.states['spc-edp.0.areas.1.ready'].val, true);
    assert.ok(has(homeA, 'nicht zum Schalten freigegeben'));

    // the salon refuses a forged write to a read only point even if the client tries it
    const site = homeA.sites.get('friseursalon');
    const res = await site.client.set('shelly.0.licht.on', true);
    assert.equal(res.ok, false);
    assert.equal(salon.states['shelly.0.licht.on'].val, false);

    // object change (new text) is passed on
    salon.setObject('spc-edp.0.areas.1.mode', { type: 'state', common: { ...salon.objects['spc-edp.0.areas.1.mode'].common, states: { 0: 'Unscharf', 1: 'Intern', 3: 'Scharf' } }, native: {} });
    await until(() => home.objects[`${M}.mode`].common.states[1] === 'Intern');

    // a new data point under the pattern appears, a deleted one disappears
    salon.point('spc-edp.0.areas.2.mode', { name: 'Zustand', type: 'number', role: 'value' }, 0);
    await until(() => home.states['bruecke.0.friseursalon.spc-edp.0.areas.2.mode'], 8000);
    salon.delObject('spc-edp.0.areas.1.openInputs');
    await until(() => !home.objects[`${M}.openInputs`], 8000);
    assert.equal(homeA.val('friseursalon.points'), 4);
});

test('connection: wrong key, salon offline and back, command while offline', async t => {
    const { port, salonA, homeA } = await twoSites(t, { homeKey: 'falsch-12345' });
    await until(() => String(homeA.val('friseursalon.lastError')).includes('Schlüssel falsch'));
    assert.equal(homeA.val('friseursalon.connected'), false);
    assert.equal(homeA.val('info.connection'), false);
    assert.ok(has(salonA, 'abgelehnt - Schlüssel falsch'));
    await stop(homeA);

    // right key: connects; then the salon goes away (restart / VPN down) and comes back
    const home = new FakeDb();
    const h = start(t, home, { name: 'Daheim', sites: [{ name: 'Friseursalon', address: `127.0.0.1:${port}`, key: KEY }] });
    await until(() => h.val('friseursalon.points') === 4);
    await stop(salonA);
    await until(() => h.val('friseursalon.connected') === false);
    assert.equal(home.states[`${M}.ready`].val, true, 'last value stays');
    home.setState(`${M}.setMode`, 3, false, 'system.adapter.smartview.0');
    await until(() => home.states[`${M}.setMode`].ack === true);
    assert.equal(home.states[`${M}.setMode`].val, 0, 'not sent, old value back');
    assert.ok(has(h, 'nicht verbunden'));

    const salon2 = new FakeDb();
    salon2.point('spc-edp.0.areas.1.ready', { name: 'Scharfschaltbereit', type: 'boolean', role: 'indicator' }, false);
    start(t, salon2, { name: 'Friseursalon', port, key: KEY, shares: [{ id: 'spc-edp.0.areas.*' }] });
    await until(() => h.val('friseursalon.connected') === true, 10000);
    await until(() => h.val('friseursalon.points') === 1);
    assert.equal(home.states[`${M}.ready`].val, false);
    assert.ok(!home.objects[`${M}.setMode`], 'no longer shared there -> removed');
});

test('sharing: a whole adapter instance without an own object', async t => {
    const port = await freePort();
    const salon = new FakeDb();
    salon.point('spc-edp.0.info.connection', { name: 'Verbunden', type: 'boolean', role: 'indicator.connected' }, true);
    salon.point('spc-edp.0.zones.1.open', { name: 'Haustür', type: 'boolean', role: 'sensor.door' }, false);
    salon.point('spc-edp.0.areas.1.setMode', { name: 'Schalten', type: 'number', role: 'level' }, 0);
    const s = start(t, salon, { name: 'Salon', port, key: KEY, shares: [{ id: 'spc-edp.0' }, { id: 'spc-edp.0.areas.1.setMode', write: true }] });
    await until(() => s.val('info.shared') === 3);
    const home = new FakeDb();
    const h = start(t, home, { name: 'Daheim', sites: [{ name: 'Salon', address: `127.0.0.1:${port}`, key: KEY }] });
    await until(() => h.val('salon.points') === 3);
    assert.equal(home.objects['bruecke.0.salon.spc-edp.0.zones.1.open'].common.write, false);
    assert.equal(home.objects['bruecke.0.salon.spc-edp.0.areas.1.setMode'].common.write, true);
});

test('settings: site removed -> its objects deleted; nothing set -> warning', async t => {
    const home = new FakeDb();
    home.setObject('bruecke.0.solarium', { type: 'device', common: { name: 'Solarium' }, native: { bridgeSite: true } });
    home.setObject('bruecke.0.solarium.x.0.a', { type: 'state', common: { type: 'number' }, native: { remote: 'x.0.a' } });
    const a = start(t, home, { name: 'Daheim', shares: [], sites: [] });
    await until(() => has(a, 'Noch nichts eingestellt'));
    assert.ok(!home.objects['bruecke.0.solarium']);
    assert.ok(!home.objects['bruecke.0.solarium.x.0.a']);
    // shares without key: nothing is offered
    const db2 = new FakeDb();
    const b = start(t, db2, { name: 'Salon', key: 'kurz', shares: [{ id: 'a.0.b' }] });
    await until(() => has(b, 'Zugriffsschlüssel fehlt'));
    assert.equal(b.server, undefined);
});
