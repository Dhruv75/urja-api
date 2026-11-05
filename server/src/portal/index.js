import { FixtureSource } from './fixture.js';
import { UrjaPortalSource } from './urja.js';
import { PortalSession } from './session.js';

/**
 * THE CONTRACT between the portal and the rest of the service. Everything downstream (normalisation,
 * hierarchy, MongoDB index, API) only ever sees these shapes, so supporting a different portal protocol
 * means changing one adapter and nothing else.
 *
 * @typedef {object} RawMeter
 * @property {string} id
 * @property {string} [name]
 * @property {string} [status]
 * @property {string} [type]
 * @property {string} [serialNumber]
 * @property {number|string|null} [lat]
 * @property {number|string|null} [lon]
 * @property {string|null} [parentId]   id of the hierarchy node the meter hangs off
 * @property {object} [attributes]      every other portal field, kept verbatim
 *
 * @typedef {object} RawNode            one level of the network hierarchy
 * @property {string} id
 * @property {string} [name]
 * @property {string} [level]
 * @property {string|null} [parentId]
 *
 * @typedef {object} RawReading         INTERVAL ENERGY in kWh for the interval starting at ts
 * @property {string|Date} ts           (adapters must convert cumulative register values to deltas)
 * @property {number|string} value
 * @property {string} [quality]
 *
 * @typedef {object} Source
 * @property {'fixture'|'portal'} name
 * @property {() => Promise<RawMeter[]>} listMeters
 * @property {() => Promise<RawNode[]>} listNodes   may be [] if the hierarchy is embedded in meter records
 * @property {(meterId: string, range: {from: Date, to: Date}) => Promise<null | {readings: RawReading[], coverage: {from: Date, to: Date}, unit: string}>} getConsumption
 *           null = unknown meter. `coverage` is the window the portal answered for (normally the requested
 *           window), NOT the timestamp of the last reading; the cache policy relies on that.
 * @property {() => Promise<{ok: boolean, detail?: string}>} ping
 * @property {() => object} state                   diagnostics for /health
 */
export function createSource(config, log) {
  if (config.sourceMode === 'fixture') return new FixtureSource();
  if (config.sourceMode === 'portal') return new UrjaPortalSource(new PortalSession(config.portal, { log }));
  throw new Error(`Unknown SOURCE_MODE "${config.sourceMode}" (expected "fixture" or "portal")`);
}
