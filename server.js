require('dotenv').config();
const app = require('./app');
const mongoose = require('mongoose');
const User = require('./models/User');

const PORT = process.env.PORT || 5000;

// Function to fix indexes
async function fixIndexes() {
    try {
        console.log('Checking and fixing database indexes...');
        
        // First, drop all existing indexes except _id
        const currentIndexes = await User.collection.getIndexes();
        
        for (let indexName in currentIndexes) {
            if (indexName !== '_id_') {
                try {
                    await User.collection.dropIndex(indexName);
                    console.log(`Dropped index: ${indexName}`);
                } catch (err) {
                    // Ignore errors when dropping indexes
                    console.log(`Note: Could not drop index ${indexName}`);
                }
            }
        }

        // Remove documents with null phone numbers
        const result = await User.deleteMany({ 
            $or: [
                { phone: null },
                { phone: { $exists: false } },
                { phone: "" }
            ]
        });
        console.log(`Removed ${result.deletedCount} invalid user documents`);

        // Try to create the phone index, ignoring if it already exists
        try {
            await User.collection.createIndex(
                { phone: 1 }, 
                { 
                    unique: true,
                    background: true,
                    sparse: true
                }
            );
            console.log('Successfully created phone index');
        } catch (err) {
            if (err.code === 86) {
                console.log('Phone index already exists, skipping creation');
            } else {
                throw err;
            }
        }

        // Show final indexes
        const finalIndexes = await User.collection.getIndexes();
        // console.log('Final indexes:', finalIndexes);
    } catch (error) {
        console.error('Error fixing indexes:', error);
        // Continue server startup even if index creation fails
    }
}

// Connect to MongoDB and fix indexes before starting the server
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB Connected:', mongoose.connection.host);
    
    try {
      await fixIndexes();
    } catch (error) {
      console.error('Index fixing failed but continuing server startup:', error);
    }
    
    // Function to find available port
const findAvailablePort = (startPort) => {
  return new Promise((resolve, reject) => {
    const server = require('http').createServer();
    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
};

// Start server with available port
findAvailablePort(PORT).then(availablePort => {
  app.listen(availablePort, () => {
    console.log(`Server running on port ${availablePort}`);
  });
});
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });