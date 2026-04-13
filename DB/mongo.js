const { MongoClient } = require("mongodb");

const DEFAULT_DB_NAME = "SmartHomeDB";
const uri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  `mongodb://127.0.0.1:27017/${DEFAULT_DB_NAME}`;

function dbNameFromUri() {
  if (process.env.MONGODB_DB || process.env.MONGO_DB) {
    return process.env.MONGODB_DB || process.env.MONGO_DB;
  }

  try {
    const parsed = new URL(uri);
    const name = parsed.pathname.replace(/^\//, "");
    return name || DEFAULT_DB_NAME;
  } catch {
    return DEFAULT_DB_NAME;
  }
}

const dbName = dbNameFromUri();
let client;
let db;
let connectPromise;

async function ensureIndexes(database) {
  await Promise.all([
    database.collection("users").createIndex({ id: 1 }, { unique: true }),
    database.collection("users").createIndex({ email: 1 }, { unique: true }),
    database.collection("users").createIndex(
      { mobile: 1 },
      {
        unique: true,
        partialFilterExpression: { mobile: { $type: "string" } },
      }
    ),
    database.collection("homes").createIndex({ id: 1 }, { unique: true }),
    database
      .collection("homeMembers")
      .createIndex({ home_id: 1, user_id: 1 }, { unique: true }),
    database
      .collection("rooms")
      .createIndex({ home_id: 1, name: 1 }, { unique: true }),
    database.collection("rooms").createIndex({ id: 1 }, { unique: true }),
    database
      .collection("homeRoomAccess")
      .createIndex({ home_id: 1, user_id: 1, room_id: 1 }, { unique: true }),
    database.collection("devices").createIndex({ id: 1 }, { unique: true }),
    database.collection("devices").createIndex({ device_id: 1 }),
    database.collection("devices").createIndex(
      { group_uid: 1, kind: 1, pin: 1 },
      {
        unique: true,
        partialFilterExpression: {
          group_uid: { $type: "string" },
          kind: { $type: "string" },
        },
      }
    ),
    database
      .collection("refreshTokens")
      .createIndex({ token: 1 }, { unique: true }),
    database
      .collection("pendingCommands")
      .createIndex({ id: 1 }, { unique: true }),
    database.collection("pendingCommands").createIndex({ device_id: 1 }),
    database
      .collection("commandLog")
      .createIndex({ id: 1 }, { unique: true }),
    database.collection("schedules").createIndex({ id: 1 }, { unique: true }),
    database.collection("schedules").createIndex({ is_active: 1 }),
    database
      .collection("deviceShadows")
      .createIndex({ device_id: 1 }, { unique: true }),
  ]);
}

async function connectMongo() {
  if (db) return db;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: Number(
        process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000
      ),
    });
    await client.connect();
    db = client.db(dbName);
    await ensureIndexes(db);
    console.log(`Connected to MongoDB database "${db.databaseName}"`);
    return db;
  })().catch((err) => {
    connectPromise = null;
    throw err;
  });

  return connectPromise;
}

async function getDb() {
  return db || connectMongo();
}

async function nextId(name) {
  const database = await getDb();
  const result = await database.collection("counters").findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    {
      upsert: true,
      returnDocument: "after",
    }
  );

  const doc = result && result.value ? result.value : result;
  if (!doc || typeof doc.seq !== "number") {
    throw new Error(`Failed to allocate id for ${name}`);
  }
  return doc.seq;
}

async function closeMongo() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
  connectPromise = null;
}

module.exports = {
  connectMongo,
  getDb,
  nextId,
  closeMongo,
};
