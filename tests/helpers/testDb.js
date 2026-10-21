/**
 * Shared test-database teardown helper.
 *
 * `mongoose.connection.dropDatabase()` alone is not enough: Mongoose keeps a
 * background model-init alive, which re-creates the collections (and therefore
 * the database) moments after the drop. The reliable sequence is:
 *   1. close the Mongoose connection (stops background model init),
 *   2. drop the database through a native MongoClient,
 *   3. close the native client.
 *
 * The database name is asserted to contain "test" so a production database can
 * never be destroyed by a mistaken run.
 */
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');

const assertTestDatabaseName = (name) => {
  if (!name || !name.includes('test')) {
    throw new Error('Refusing cleanup: not a test database (got ' + name + ')');
  }
};

const dropTestDatabase = async (uri, name) => {
  assertTestDatabaseName(name);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  const client = new MongoClient(uri);
  try {
    await client.connect();
    await client.db(name).dropDatabase();
  } finally {
    await client.close();
  }
};

module.exports = { dropTestDatabase, assertTestDatabaseName };
