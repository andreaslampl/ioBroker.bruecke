# ioBroker.bruecke

ioBroker adapter "Brücke": passes chosen data points between the owner's ioBroker installations at different sites
(home, hair salon, solarium; all on VPN to home). Owner found an MQTT broker too complicated; multihost was advised
against (shared DB, sites would depend on the VPN). Every site keeps running alone.

## Layout

- `lib/protocol.js` – wire protocol (see the header): hello/auth/ok with HMAC-SHA256 challenge both ways (key never sent),
  then binary frames AES-256-GCM with a session key from key + both nonces, counter `n` per direction (replay refused);
  `cleanShares()` (exact ids before patterns with *), `shareFor()`, `cleanSites()` (name -> slug, address -> ws URL,
  key >= 8), `pickCommon()` / `pickState()`.
- `lib/server.js` – `BridgeServer` (ws, port 8102): auth within 10 s, 5 wrong per IP -> 1 min, `init` with all shared
  points (common + folder names `parents` + state), `state` / `object` broadcasts, `set` only for write shares;
  ping 15 s, dead after 45 s.
- `lib/client.js` – `BridgeClient`: one per site, backoff 2…60 s, verifies the server's mac, `set()` -> {ok, error} (10 s).
- `main.js` – shares resolved to state objects (`collectShares`, patterns re-resolved 2 s after object changes),
  `onStateChange` foreign -> server; sites -> `bruecke.0.<slug>` (device, native.bridgeSite) + connected/lastSeen/
  remoteName/points/lastError, mirrors `<slug>.<remote id>` (native.remote; folders named from the remote `parents`),
  mirrors not in a new init deleted, sites removed from the settings deleted; local ack=false on a mirror -> client.set,
  refused / offline -> last remote value restored (ack). Settings key: encryptedNative; sites table only protectedNative
  (keys in tables cannot be encrypted by admin).
- `test/` – `node --test`; `fake.js` = fake adapter-core with one FakeDb per site (two sites in one process).

## Status

- 0.1.0: built and tested with simulated sites only; not yet on the owner's three ioBroker.
- 0.1.1: owner did not want to type ids -> shares column objectId with customFilter state/channel/device/folder;
  `expandFolders()` turns a non-state id into `id.*`; patterns sorted longer first (more specific folder wins).
  The admin picker with folders was not checked in a real admin.
- Possible later: SmartView `fillAlarm()` only knows `spc-edp.N` / `nox_alarmzentrale.N` prefixes - mirrored alarm points
  (`bruecke.0.<site>.spc-edp.0.areas.N.*`) must be picked by hand in the tile.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.bruecke`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses or keys in the repository (use 192.168.x.x examples).
