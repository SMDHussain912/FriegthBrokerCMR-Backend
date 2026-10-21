require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./config/db');

const PORT = process.env.PORT || 5000;

// Connect to MongoDB then start listening
const startServer = async () => {
  await connectDB();

  // Ensure the unique approval index exists (repairing legacy duplicates)
  // and recover loads orphaned by a crash mid-assignment.
  try {
    await app.initializeDatabaseState();
  } catch (initError) {
    console.error(`[Server] Database state initialization failed: ${initError.message}`);
    process.exit(1);
  }
  
  const server = app.listen(PORT, () => {
    console.log(`[Express] Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
    console.log(`[Express] Health check available at: http://localhost:${PORT}/api/health`);
  });

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Gracefully closing HTTP server and MongoDB pool...`);
    server.close(async () => {
      const mongoose = require('mongoose');
      await mongoose.connection.close();
      console.log('[Server] Shutdown complete.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
