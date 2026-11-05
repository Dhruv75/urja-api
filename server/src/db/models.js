import mongoose from 'mongoose';

const { Schema } = mongoose;
const opts = { versionKey: false, minimize: false };

// One document per meter. Portal-derived fields are rewritten on every sync; `readings` (cache bookkeeping) is not.
const meterSchema = new Schema(
  {
    _id: String, // the portal's meter id
    name: String,
    serialNumber: String,
    type: String,
    status: String,
    lat: Number,
    lon: Number,
    nodeId: String, // hierarchy node it hangs off (null = unplaced)
    path: [String], // ancestor node ids, root first, ending at nodeId. Multikey-indexed: "everything under X".
    attributes: Schema.Types.Mixed, // every other portal field, verbatim
    issues: [String],
    searchKey: String,
    syncedAt: Date,
    readings: { from: Date, to: Date, fetchedAt: Date, unit: String }, // coverage of the last readings fetch
  },
  opts,
);
meterSchema.index({ nodeId: 1 });
meterSchema.index({ path: 1 });
meterSchema.index({ status: 1 });
meterSchema.index({ lat: 1, lon: 1 }); // bounding-box prefilter for "nearby"

const nodeSchema = new Schema(
  {
    _id: String,
    name: String,
    level: String,
    parentId: String,
    depth: Number,
    path: [String],
    childIds: [String],
    directMeterCount: Number,
    meterCount: Number,
    issues: [String],
    attributes: Schema.Types.Mixed,
    syncedAt: Date,
  },
  opts,
);
nodeSchema.index({ parentId: 1 });

const readingSchema = new Schema({ meterId: String, ts: Date, value: Number, quality: String }, opts);
readingSchema.index({ meterId: 1, ts: 1 }, { unique: true });

const issueSchema = new Schema({ kind: String, refId: String, code: String, message: String, syncedAt: Date }, opts);
issueSchema.index({ code: 1 });

const syncSchema = new Schema(
  { _id: String, status: String, startedAt: Date, finishedAt: Date, lastSuccessAt: Date, durationMs: Number, counts: Schema.Types.Mixed, error: String },
  opts,
);

export const Meter = mongoose.models.Meter ?? mongoose.model('Meter', meterSchema);
export const HierarchyNode = mongoose.models.HierarchyNode ?? mongoose.model('HierarchyNode', nodeSchema, 'nodes');
export const Reading = mongoose.models.Reading ?? mongoose.model('Reading', readingSchema);
export const DataIssue = mongoose.models.DataIssue ?? mongoose.model('DataIssue', issueSchema, 'data_issues');
export const SyncState = mongoose.models.SyncState ?? mongoose.model('SyncState', syncSchema, 'sync_state');
export const allModels = [Meter, HierarchyNode, Reading, DataIssue, SyncState];

export async function connectDb(uri, { dbName } = {}) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, dbName });
  await Promise.all(allModels.map((m) => m.init())); // build indexes before serving traffic
  return mongoose.connection;
}
export const disconnectDb = () => mongoose.disconnect();
