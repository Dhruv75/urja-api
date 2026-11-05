import { PortalNotMappedError } from '../errors.js';

const NOT_MAPPED =
  'The Urja portal adapter is not mapped yet: login works, but its data pages/endpoints have not been ' +
  'reverse-engineered. Run `npm run explore` from a machine that can reach the portal, then implement the ' +
  'methods in server/src/portal/urja.js (see PROTOCOL.md).';

/**
 * Adapter for the real Urja Meter Ops portal. It must turn whatever the portal serves (HTML tables,
 * JSON endpoints, CSV exports...) into the raw shapes documented in ./index.js.
 *
 * STATUS: not implemented. The sandbox this repo was scaffolded in could not reach the portal, so the
 * protocol has not been observed and nothing here is guessed. `ping()` only proves that the generic
 * form login in PortalSession works against the live portal.
 */
export class UrjaPortalSource {
  name = 'portal';

  constructor(session) {
    this.session = session;
  }

  async ping() {
    await this.session.ensureLoggedIn();
    return { ok: true, detail: 'authenticated; data endpoints are not mapped yet' };
  }

  state() {
    return this.session.state();
  }

  async listMeters() {
    throw new PortalNotMappedError(NOT_MAPPED);
  }

  async listNodes() {
    throw new PortalNotMappedError(NOT_MAPPED);
  }

  async getConsumption() {
    throw new PortalNotMappedError(NOT_MAPPED);
  }
}
