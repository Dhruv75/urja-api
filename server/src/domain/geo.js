const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export const validLatLon = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Great-circle distance in metres. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Lat/lon box that fully contains the circle. Used as an index-friendly prefilter;
 * exact distance is checked afterwards. Does not wrap the antimeridian (documented limit).
 */
export function boundingBox(lat, lon, radiusM) {
  const dLat = toDeg(radiusM / EARTH_RADIUS_M);
  const cos = Math.max(Math.cos(toRad(lat)), 1e-6);
  const dLon = toDeg(radiusM / (EARTH_RADIUS_M * cos));
  return { minLat: Math.max(-90, lat - dLat), maxLat: Math.min(90, lat + dLat), minLon: lon - dLon, maxLon: lon + dLon };
}
